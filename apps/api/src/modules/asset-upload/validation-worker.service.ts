import { isMaterialKind } from './material-policy.js';
import { validateMaterialSource } from './material-validation.js';
import { createClaimHeartbeatGuard } from '../upload-lifecycle/claim-heartbeat.js';
import { materializeAndValidateGameSource } from '../admin/game-upload/validation-worker.game-processor.js';
import { decodePersistedSourceIdentityManifest } from '../admin/game-upload/source-identity.js';
import type { AssetUploadRepository, AssetUploadValidationStorage } from './ports.js';
import {
	isWorkerSourceObjectMissing,
	MAX_WORKER_VALIDATION_ATTEMPTS,
	retryBudgetReason,
	WorkerGenerationFencedError,
} from '../upload-lifecycle/worker-errors.js';

const VALIDATION_LEASE_MS = 120_000;

/** Dedicated worker use-case; no Fastify imports or response stream capability. */
export function createGameUploadValidationWorker(deps: {
	repository: AssetUploadRepository;
	storage: AssetUploadValidationStorage;
	ids: { next(): string };
	tempRoot: string;
	tempDiskBudgetBytes: number;
	logger: { error(context: Record<string, unknown>, message: string): void };
	wakeDeletionWorker(): void;
}) {
	return {
		async runPass(signal?: AbortSignal): Promise<{ claimed: number; ready: number; rejected: number; retried: number }> {
			if (signal?.aborted) return { claimed: 0, ready: 0, rejected: 0, retried: 0 };
			const token = deps.ids.next();
			const sessions = [
				...await deps.repository.claimVerifying('GAME', 8, token, VALIDATION_LEASE_MS),
				...await deps.repository.claimVerifying('DOCUMENT', 2, token, VALIDATION_LEASE_MS),
				...await deps.repository.claimVerifying('ATTACHMENT', 2, token, VALIDATION_LEASE_MS),
			];
			let ready = 0;
			let rejected = 0;
			let retried = 0;
			for (const session of sessions) {
				if (signal?.aborted) break;
				const claim = createClaimHeartbeatGuard({
					heartbeatMs: 30_000,
					lostMessage: 'Asset upload validation lease was lost',
					outerSignal: signal,
					renew: () => deps.repository.renewValidation(session.id, token, VALIDATION_LEASE_MS).then((owned) => ({ count: owned ? 1 : 0 })),
					logHeartbeatFailure: (error) => deps.logger.error({ error, sessionId: session.id }, 'Asset upload validation heartbeat failed'),
				});
				try {
					if (session.kind !== 'GAME' && !isMaterialKind(session.kind)) continue;
					const source = await deps.storage.stream(session.bucket, session.objectKey, { signal: claim.signal });
					if (source.size !== Number(session.totalBytes)) throw new Error('Completed direct GAME object size mismatch');
					let validated: { mimeType: string; checksum?: string } = { mimeType: 'application/zip' };
					if (isMaterialKind(session.kind)) validated = await validateMaterialSource({ session, source, signal: claim.signal });
					else await materializeAndValidateGameSource({
						session: {
							id: session.id, totalBytes: session.totalBytes,
							sourceIdentityAlgorithm: session.sourceIdentityAlgorithm,
							sourceIdentity: session.sourceIdentity,
							sourceIdentityBlockSizeBytes: session.sourceIdentityBlockSizeBytes,
							sourceIdentityBlockManifest: decodePersistedSourceIdentityManifest(session.sourceIdentityBlockManifest),
						},
						source: source.body,
						tempRoot: deps.tempRoot,
						physicalByteLimit: deps.tempDiskBudgetBytes,
						signal: claim.signal,
					});
					await claim.assertOwned();
					await deps.repository.commitGameReady({ session, token, ...validated });
					deps.wakeDeletionWorker();
					ready++;
				} catch (error) {
					if (claim.isLost()) {
						retried++;
						continue;
					}
					// ZIP, source-identity, declared-size, and authoritative 404 failures are deterministic.
					const message = String(error instanceof Error ? error.message : error);
					const terminal = isWorkerSourceObjectMissing(error)
						|| error instanceof WorkerGenerationFencedError
						|| /ZIP|source identity|size mismatch|invalid|corrupt|CRC|GAME_REPLACEMENT_FENCE_LOST|Project modifications are closed|staging project/i.test(message);
					if (terminal || (session.validationAttemptCount ?? 0) >= MAX_WORKER_VALIDATION_ATTEMPTS) {
						const reason = terminal ? message : retryBudgetReason('GAME', error);
						if (await deps.repository.markRejected(session.id, session.generation, token, reason)) rejected++;
						else retried++;
					} else {
						deps.logger.error({ error, sessionId: session.id }, 'Direct GAME validation will retry');
						retried++;
					}
				} finally {
					claim.stop();
				}
			}
			return { claimed: sessions.length, ready, rejected, retried };
		},
	};
}
