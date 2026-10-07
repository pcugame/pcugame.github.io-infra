import type { Readable } from 'node:stream';
import { ZipValidationError } from '../../shared/archive-errors.js';
import { ProjectUploadPolicyRejectedError } from '../admin/project-access.service.js';
import { isMaterialKind } from './material-policy.js';
import { validateMaterialSource } from './material-validation.js';
import { createClaimHeartbeatGuard } from '../upload-lifecycle/claim-heartbeat.js';
import { materializeAndValidateGameSource } from '../admin/game-upload/validation-worker.game-processor.js';
import { decodePersistedSourceIdentityManifest } from '../admin/game-upload/source-identity.js';
import type { AssetUploadRepository, AssetUploadValidationStorage } from './ports.js';
import {
	isWorkerSourceObjectMissing,
	isWorkerOperationAborted,
	WorkerInputRejectedError,
	WorkerOperatorRequiredError,
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
				let sourceBody: Readable | undefined;
				try {
					if (session.kind !== 'GAME' && !isMaterialKind(session.kind)) continue;
					const source = await deps.storage.stream(session.bucket, session.objectKey, { signal: claim.signal });
					sourceBody = source.body;
					if (source.size !== Number(session.totalBytes)) throw new WorkerInputRejectedError('Completed direct GAME object size mismatch');
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
					claim.signal.throwIfAborted();
					await deps.repository.commitGameReady({ session, token, ...validated });
					deps.wakeDeletionWorker();
					ready++;
				} catch (error) {
					if (claim.isLost() || claim.signal.aborted || isWorkerOperationAborted(error)) {
						retried++;
						continue;
					}
					// Only explicit content/policy failures authorize source cleanup.
					const message = String(error instanceof Error ? error.message : error);
					const terminal = isWorkerSourceObjectMissing(error)
						|| error instanceof WorkerGenerationFencedError
						|| error instanceof ZipValidationError
						|| error instanceof WorkerInputRejectedError
						|| error instanceof ProjectUploadPolicyRejectedError;
					if (terminal || error instanceof WorkerOperatorRequiredError || (session.validationAttemptCount ?? 0) >= MAX_WORKER_VALIDATION_ATTEMPTS) {
						const reason = terminal ? message : error instanceof WorkerOperatorRequiredError
							? `OPERATOR_REQUIRED: ${message}` : retryBudgetReason('GAME', error);
						const rejection = { reason, sourceDisposition: terminal ? 'DELETE' as const : 'RETAIN' as const };
						if (await deps.repository.markRejected(session.id, session.generation, token, rejection)) rejected++;
						else retried++;
					} else {
						deps.logger.error({ error, sessionId: session.id }, 'Direct GAME validation will retry');
						retried++;
					}
				} finally {
					claim.stop();
					if (sourceBody && !sourceBody.destroyed) sourceBody.destroy();
				}
			}
			return { claimed: sessions.length, ready, rejected, retried };
		},
	};
}
