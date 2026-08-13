import type { ObjectStorage } from '../../application/ports.js';
import { createClaimToken } from '../../shared/claim-token.js';
import {
	createObjectReferenceIndex,
	type ObjectReferenceInventory,
} from '../orphan/reference-resolver.js';
import { createClaimHeartbeatGuard } from '../upload-lifecycle/claim-heartbeat.js';
import type { NewUploadIntent, UploadIntentRepository } from './ports.js';

const CLAIM_LEASE_MS = 2 * 60 * 1000;
const CLAIM_HEARTBEAT_MS = 30 * 1000;
const DEFAULT_GRACE_MS = 60 * 60 * 1000;
const BATCH_SIZE = 50;

export function createUploadIntentService(deps: {
	repository: UploadIntentRepository;
	references: { collect(): Promise<ObjectReferenceInventory> };
	storage: Pick<ObjectStorage, 'head'>;
	clock: { now(): Date };
	ids?: { next(): string };
	logger: {
		error(context: Record<string, unknown>, message: string): void;
		info(context: Record<string, unknown>, message: string): void;
	};
	graceMs?: number;
}) {
	const repository = deps.repository;
	const graceMs = deps.graceMs ?? DEFAULT_GRACE_MS;
	return {
		async prepare(input: Omit<NewUploadIntent, 'id' | 'notBefore'>): Promise<string> {
			const now = deps.clock.now();
			const id = deps.ids?.next() ?? createClaimToken();
			const prepared = await repository.prepare({
				...input,
				id,
				notBefore: new Date(now.getTime() + graceMs),
			});
			return prepared.id;
		},
		markUploaded: (id: string) => repository.markUploaded(id).then(() => undefined),
		isUncommitted: (id: string) => repository.isUncommitted(id),
		recordAmbiguousError: (id: string, error: unknown) => (
			repository.recordAmbiguousError(id, error).then(() => undefined)
		),
		async sweep(signal?: AbortSignal): Promise<{ tried: number; referenced: number; queued: number; missing: number }> {
			if (signal?.aborted) return { tried: 0, referenced: 0, queued: 0, missing: 0 };
			const now = deps.clock.now();
			const claimToken = deps.ids?.next() ?? createClaimToken();
			const intents = await repository.claimStale(
				BATCH_SIZE,
				claimToken,
				CLAIM_LEASE_MS,
			);
			if (intents.length === 0) {
				return { tried: 0, referenced: 0, queued: 0, missing: 0 };
			}
			let referenceIndex: ReturnType<typeof createObjectReferenceIndex>;
			try {
				referenceIndex = createObjectReferenceIndex(await deps.references.collect());
			} catch (error) {
				await Promise.allSettled(intents.map((intent) => {
					const backoff = Math.min(
						60 * 60 * 1000,
						30_000 * (2 ** Math.min(intent.attemptCount, 8)),
					);
					return repository.markSweepFailed(
						intent.id,
						claimToken,
						error,
						new Date(now.getTime() + backoff),
					);
				}));
				deps.logger.error(
					{ error, claimed: intents.length },
					'Upload-intent reference snapshot failed; claimed intents were requeued',
				);
				return { tried: intents.length, referenced: 0, queued: 0, missing: 0 };
			}
			let referenced = 0;
			let queued = 0;
			let missing = 0;
			for (const intent of intents) {
				if (signal?.aborted) break;
				const claim = createClaimHeartbeatGuard({
					heartbeatMs: CLAIM_HEARTBEAT_MS,
					lostMessage: 'Upload intent claim was lost',
					outerSignal: signal,
					renew: () => repository.renewClaim(
						intent.id,
						claimToken,
						CLAIM_LEASE_MS,
					),
					logHeartbeatFailure: (error) => deps.logger.error(
						{ error, intentId: intent.id },
						'Upload-intent claim heartbeat failed',
					),
				});
				try {
					if (referenceIndex.referencesTarget({
						bucket: intent.bucket,
						targetKind: 'EXACT',
						key: intent.storageKey,
					}, { ignoreSource: `upload-intent:${intent.id}` })) {
						await claim.assertOwned();
						await repository.markReferenced(intent.id, claimToken);
						referenced++;
						continue;
					}
					await claim.assertOwned();
					const object = await deps.storage.head(
						intent.bucket,
						intent.storageKey,
						{ signal: claim.signal },
					);
					await claim.assertOwned();
					if (!object) {
						await repository.markMissing(intent.id, claimToken);
						missing++;
						continue;
					}
					await repository.queueCleanup(
						intent.id,
						claimToken,
						intent.bucket,
						intent.storageKey,
					);
					queued++;
				} catch (error) {
					if (claim.isLost()) {
						deps.logger.error(
							{ error, intentId: intent.id },
							'Upload-intent sweep stopped after claim loss',
						);
						continue;
					}
					const backoff = Math.min(60 * 60 * 1000, 30_000 * (2 ** Math.min(intent.attemptCount, 8)));
					await repository.markSweepFailed(
						intent.id,
						claimToken,
						error,
						new Date(now.getTime() + backoff),
					).catch((writeError) => {
						deps.logger.error(
							{ error: writeError, intentId: intent.id },
							'Failed to persist upload-intent sweep failure',
						);
					});
				} finally {
					claim.stop();
				}
			}
			deps.logger.info(
				{ tried: intents.length, referenced, queued, missing },
				'Upload-intent sweep complete',
			);
			return { tried: intents.length, referenced, queued, missing };
		},
	};
}
