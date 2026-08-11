import { createClaimToken } from '../../shared/claim-token.js';

export interface OrphanServiceDependencies {
	clock: { now(): Date };
	storage: {
		delete(
			bucket: string,
			key: string,
			request?: { signal?: AbortSignal; requestTimeoutMs?: number },
		): Promise<void>;
		listKeys?(
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
		claimPendingOrphans?(
			limit: number,
			now: Date,
			claimUntil: Date,
			claimToken: string,
		): Promise<{
			id: number;
			bucket: string;
			storageKey: string;
			targetKind: 'EXACT' | 'PREFIX';
			attemptCount: number;
		}[]>;
		findPendingOrphans(limit: number, cutoff: Date): Promise<{
			id: number;
			bucket: string;
			storageKey: string;
			attemptCount: number;
		}[]>;
		markResolved(id: number, now: Date): Promise<unknown>;
		markFailed(id: number, error: unknown, now: Date): Promise<unknown>;
		markClaimResolved?(id: number, claimToken: string, now: Date): Promise<unknown>;
		renewClaim?(
			id: number,
			claimToken: string,
			now: Date,
			claimUntil: Date,
		): Promise<unknown>;
		markClaimCancelled?(
			id: number,
			claimToken: string,
			reason: string,
			now: Date,
		): Promise<unknown>;
		markClaimFailed?(
			id: number,
			claimToken: string,
			error: unknown,
			now: Date,
			nextAttemptAt: Date,
		): Promise<unknown>;
	};
	references?: {
		isReferenced(target: {
			bucket: string;
			targetKind: 'EXACT' | 'PREFIX';
			key: string;
		}): Promise<boolean>;
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
): Promise<void> {
	try {
		await deps.repository.upsertOrphan(
			bucket,
			storageKey,
			reason,
			undefined,
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

/**
 * Pull a batch of pending orphans and retry their S3 delete. Intended to be called
 * by a periodic interval in server.ts. Safe to call concurrently — each row is updated
 * independently and upsert keeps the set idempotent.
 */
export async function runOrphanReaper(
	deps: OrphanServiceDependencies,
	signal?: AbortSignal,
): Promise<{ tried: number; resolved: number; failed: number }> {
	if (signal?.aborted) return { tried: 0, resolved: 0, failed: 0 };
	const now = deps.clock.now();
	const claimToken = deps.ids?.next() ?? createClaimToken();
	const pending = deps.repository.claimPendingOrphans
		? await deps.repository.claimPendingOrphans(
			REAP_BATCH_SIZE,
			now,
			new Date(now.getTime() + CLAIM_LEASE_MS),
			claimToken,
		)
		: (await deps.repository.findPendingOrphans(
			REAP_BATCH_SIZE,
			new Date(now.getTime() - REAP_COOLDOWN_MS),
		)).map((orphan) => ({
			...orphan,
			targetKind: orphan.storageKey.endsWith('/') ? 'PREFIX' as const : 'EXACT' as const,
		}));
	if (pending.length === 0) return { tried: 0, resolved: 0, failed: 0 };

	let resolved = 0;
	let failed = 0;

	for (const orphan of pending) {
		if (signal?.aborted) break;
		let heartbeat: NodeJS.Timeout | undefined;
		let claimLost: Error | undefined;
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
		if (deps.repository.renewClaim) {
			heartbeat = setInterval(() => {
				const heartbeatNow = deps.clock.now();
				void deps.repository.renewClaim!(
					orphan.id,
					claimToken,
					heartbeatNow,
					new Date(heartbeatNow.getTime() + CLAIM_LEASE_MS),
				).then((result) => {
					if (typeof result === 'object'
						&& result !== null
						&& 'count' in result
						&& result.count !== 1) {
						loseClaim(new Error('Orphan deletion claim was lost'));
					}
				}).catch((error) => {
					deps.logger.error(
						{ error, orphanId: orphan.id },
						'Orphan deletion claim heartbeat failed',
					);
					loseClaim(error);
				});
			}, 30 * 1000);
			heartbeat.unref();
		}
		try {
			const referenced = await deps.references?.isReferenced({
				bucket: orphan.bucket,
				targetKind: orphan.targetKind,
				key: orphan.storageKey,
			}) ?? false;
			assertClaimOwned();
			if (referenced) {
				if (deps.repository.markClaimCancelled) {
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
				} else {
					await deps.repository.markResolved(orphan.id, now);
				}
				resolved++;
				continue;
			}

			if (orphan.targetKind === 'PREFIX') {
				if (!deps.storage.listKeys) {
					throw new Error('Object storage does not support durable prefix reconciliation');
				}
				const keys = await deps.storage.listKeys(
					orphan.bucket,
					orphan.storageKey,
					{ signal: operationSignal, requestTimeoutMs: STORAGE_REQUEST_TIMEOUT_MS },
				);
				for (const key of keys) {
					assertClaimOwned();
					if (operationSignal.aborted) {
						throw operationSignal.reason ?? new Error('Orphan reaper aborted');
					}
					await deps.storage.delete(orphan.bucket, key, {
						signal: operationSignal,
						requestTimeoutMs: STORAGE_REQUEST_TIMEOUT_MS,
					});
				}
			} else {
				await deps.storage.delete(orphan.bucket, orphan.storageKey, {
					signal: operationSignal,
					requestTimeoutMs: STORAGE_REQUEST_TIMEOUT_MS,
				});
			}
			assertClaimOwned();
			if (deps.repository.markClaimResolved) {
				await deps.repository.markClaimResolved(orphan.id, claimToken, now);
			} else {
				await deps.repository.markResolved(orphan.id, now);
			}
			resolved++;
		} catch (err) {
			const backoffMs = Math.min(
				REAP_COOLDOWN_MS * (2 ** Math.min(orphan.attemptCount, 8)),
				MAX_BACKOFF_MS,
			);
			const failureWrite = deps.repository.markClaimFailed
				? deps.repository.markClaimFailed(
					orphan.id,
					claimToken,
					err,
					now,
					new Date(now.getTime() + backoffMs),
				)
				: deps.repository.markFailed(orphan.id, err, now);
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
		recordOrphan: (bucket: string, key: string, reason: string) => (
			recordOrphan(deps, bucket, key, reason)
		),
		runOrphanReaper: (signal?: AbortSignal) => runOrphanReaper(deps, signal),
	};
}
