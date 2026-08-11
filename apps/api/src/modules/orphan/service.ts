import { createClaimToken } from '../../shared/claim-token.js';
import {
	createObjectReferenceIndex,
	type ObjectReferenceInventory,
} from './reference-resolver.js';

export interface OrphanServiceDependencies {
	clock: { now(): Date };
	storage: {
		delete(
			bucket: string,
			key: string,
			request?: { signal?: AbortSignal; requestTimeoutMs?: number },
		): Promise<void>;
		listKeys(
			bucket: string,
			prefix: string,
			request?: { signal?: AbortSignal; requestTimeoutMs?: number },
		): Promise<string[]>;
	};
	repository: {
		upsertOrphan(
			bucket: string,
			key: string,
			reason: string,
			targetKind?: 'EXACT' | 'PREFIX',
			now?: Date,
		): Promise<unknown>;
		claimPendingOrphans(
			limit: number,
			eligibleAt: Date,
			claimToken: string,
			claimLeaseMs: number,
		): Promise<{
			id: number;
			bucket: string;
			storageKey: string;
			targetKind: 'EXACT' | 'PREFIX';
			attemptCount: number;
		}[]>;
		markClaimResolved(id: number, claimToken: string, now: Date): Promise<unknown>;
		renewActiveClaim(
			id: number,
			claimToken: string,
			claimLeaseMs: number,
		): Promise<{ count: number }>;
		markClaimCancelled(
			id: number,
			claimToken: string,
			reason: string,
			now: Date,
		): Promise<unknown>;
		markClaimFailed(
			id: number,
			claimToken: string,
			error: unknown,
			now: Date,
			nextAttemptAt: Date,
		): Promise<unknown>;
	};
	references: {
		collect(): Promise<ObjectReferenceInventory>;
	};
	ids?: { next(): string };
	logger: {
		info(context: Record<string, unknown>, message: string): void;
		error(context: Record<string, unknown>, message: string): void;
	};
}

/** Persist an S3 object that needs deleting before a caller records completion. */
export async function recordOrphan(
	deps: OrphanServiceDependencies,
	bucket: string,
	storageKey: string,
	reason: string,
	targetKind: 'EXACT' | 'PREFIX' = 'EXACT',
): Promise<void> {
	try {
		await deps.repository.upsertOrphan(
			bucket,
			storageKey,
			reason,
			targetKind,
			deps.clock.now(),
		);
	} catch (err) {
		deps.logger.error(
			{ err, bucket, storageKey, reason },
			'Failed to durably record orphan',
		);
		throw err;
	}
}

const REAP_BATCH_SIZE = 50;
const REAP_COOLDOWN_MS = 5 * 60 * 1000;
const CLAIM_LEASE_MS = 2 * 60 * 1000;
const STORAGE_REQUEST_TIMEOUT_MS = 60 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const NOISY_ATTEMPT_THRESHOLD = 10;

function boundedStorageRequest(signal: AbortSignal) {
	return {
		signal: AbortSignal.any([
			signal,
			AbortSignal.timeout(STORAGE_REQUEST_TIMEOUT_MS),
		]),
		requestTimeoutMs: STORAGE_REQUEST_TIMEOUT_MS,
	};
}

/**
 * Claim one durable batch, collect one immutable reference snapshot, and retry
 * storage deletion without holding the database advisory lock during I/O.
 */
export async function runOrphanReaper(
	deps: OrphanServiceDependencies,
	signal?: AbortSignal,
): Promise<{ tried: number; resolved: number; failed: number }> {
	if (signal?.aborted) return { tried: 0, resolved: 0, failed: 0 };
	const now = deps.clock.now();
	const claimToken = deps.ids?.next() ?? createClaimToken();
	const pending = await deps.repository.claimPendingOrphans(
		REAP_BATCH_SIZE,
		now,
		claimToken,
		CLAIM_LEASE_MS,
	);
	if (pending.length === 0) return { tried: 0, resolved: 0, failed: 0 };

	let inventory: ObjectReferenceInventory;
	try {
		inventory = await deps.references.collect();
	} catch (error) {
		await Promise.allSettled(pending.map((orphan) => {
			const backoffMs = Math.min(
				REAP_COOLDOWN_MS * (2 ** Math.min(orphan.attemptCount, 8)),
				MAX_BACKOFF_MS,
			);
			return deps.repository.markClaimFailed(
				orphan.id,
				claimToken,
				error,
				now,
				new Date(now.getTime() + backoffMs),
			);
		}));
		deps.logger.error(
			{ error, claimed: pending.length },
			'Orphan reference snapshot failed; claimed deletions were requeued',
		);
		return { tried: pending.length, resolved: 0, failed: pending.length };
	}
	const referenceIndex = createObjectReferenceIndex(inventory);

	let resolved = 0;
	let failed = 0;

	for (const orphan of pending) {
		if (signal?.aborted) break;
		let heartbeat: NodeJS.Timeout | undefined;
		let claimLost: Error | undefined;
		let renewalFlight: Promise<void> | undefined;
		let heartbeatActive = true;
		const claimAbort = new AbortController();
		const operationSignal = signal
			? AbortSignal.any([signal, claimAbort.signal])
			: claimAbort.signal;
		const loseClaim = (error: unknown) => {
			if (!heartbeatActive || claimLost) return;
			claimLost = error instanceof Error
				? error
				: new Error(String(error));
			claimAbort.abort(claimLost);
		};
		const assertClaimOwned = () => {
			if (claimLost) throw claimLost;
		};
		const renewOwnedClaim = (): Promise<void> => {
			assertClaimOwned();
			renewalFlight ??= (async () => {
				try {
					const result = await deps.repository.renewActiveClaim(
						orphan.id,
						claimToken,
						CLAIM_LEASE_MS,
					);
					if (result.count !== 1) {
						throw new Error('Orphan deletion claim was lost');
					}
				} catch (error) {
					loseClaim(error);
					throw claimLost ?? error;
				}
			})().finally(() => {
				renewalFlight = undefined;
			});
			return renewalFlight;
		};
		heartbeat = setInterval(() => {
			void renewOwnedClaim().catch((error) => {
				deps.logger.error(
					{ error, orphanId: orphan.id },
					'Orphan deletion claim heartbeat failed',
				);
				loseClaim(error);
			});
		}, 30 * 1000);
		heartbeat.unref();
		try {
			const referenced = referenceIndex.referencesTarget({
				bucket: orphan.bucket,
				targetKind: orphan.targetKind,
				key: orphan.storageKey,
			});
			assertClaimOwned();
			if (referenced) {
				const cancellation = await deps.repository.markClaimCancelled(
					orphan.id,
					claimToken,
					'live-reference-detected',
					now,
				);
				if (typeof cancellation === 'object'
					&& cancellation !== null
					&& 'requeued' in cancellation
					&& cancellation.requeued === true) {
					continue;
				}
				resolved++;
				continue;
			}

			if (orphan.targetKind === 'PREFIX') {
				// A successful database-time renewal proves this claim has stayed
				// continuously live since the batch snapshot. An expired claim can
				// never be revived, so a stale snapshot fails closed here.
				await renewOwnedClaim();
				const keys = await deps.storage.listKeys(
					orphan.bucket,
					orphan.storageKey,
					boundedStorageRequest(operationSignal),
				);
				for (const key of keys) {
					// Prefix batches may outlive one lease. Re-prove continuity before
					// every destructive request without holding a DB lock during I/O.
					await renewOwnedClaim();
					if (operationSignal.aborted) {
						throw operationSignal.reason ?? new Error('Orphan reaper aborted');
					}
					await deps.storage.delete(
						orphan.bucket,
						key,
						boundedStorageRequest(operationSignal),
					);
				}
			} else {
				await renewOwnedClaim();
				await deps.storage.delete(
					orphan.bucket,
					orphan.storageKey,
					boundedStorageRequest(operationSignal),
				);
			}
			assertClaimOwned();
			await deps.repository.markClaimResolved(orphan.id, claimToken, now);
			resolved++;
		} catch (err) {
			const backoffMs = Math.min(
				REAP_COOLDOWN_MS * (2 ** Math.min(orphan.attemptCount, 8)),
				MAX_BACKOFF_MS,
			);
			const failureWrite = deps.repository.markClaimFailed(
				orphan.id,
				claimToken,
				err,
				now,
				new Date(now.getTime() + backoffMs),
			);
			await failureWrite.catch((dbErr) => {
				deps.logger.error({ err: dbErr, orphanId: orphan.id }, 'Failed to record orphan reap attempt');
			});
			if (orphan.attemptCount + 1 >= NOISY_ATTEMPT_THRESHOLD) {
				deps.logger.error(
					{ err, orphanId: orphan.id, bucket: orphan.bucket, storageKey: orphan.storageKey, attemptCount: orphan.attemptCount + 1 },
					'Orphan reap has failed repeatedly — manual intervention likely needed',
				);
			}
			failed++;
		} finally {
			heartbeatActive = false;
			if (heartbeat) clearInterval(heartbeat);
		}
	}

	deps.logger.info({ tried: pending.length, resolved, failed }, 'Orphan reaper batch complete');
	return { tried: pending.length, resolved, failed };
}

export function createOrphanService(deps: OrphanServiceDependencies) {
	return {
		recordOrphan: (
			bucket: string,
			key: string,
			reason: string,
			targetKind?: 'EXACT' | 'PREFIX',
		) => (
			recordOrphan(deps, bucket, key, reason, targetKind)
		),
		runOrphanReaper: (signal?: AbortSignal) => runOrphanReaper(deps, signal),
	};
}
