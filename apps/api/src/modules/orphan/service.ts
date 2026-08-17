import { createClaimToken } from '../../shared/claim-token.js';
import { deletePrefixPages } from '../../application/prefix-deletion.js';
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
		listKeyPage(
			bucket: string,
			prefix: string,
			page: { startAfter?: string; maxKeys: number },
			request?: { signal?: AbortSignal; requestTimeoutMs?: number },
		): Promise<{ keys: string[]; isTruncated: boolean }>;
		deleteKeys(
			bucket: string,
			keys: readonly string[],
			request?: { signal?: AbortSignal; requestTimeoutMs?: number },
		): Promise<{ deleted: string[]; failures: Array<{ key: string; code?: string; message?: string }> }>;
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
		markClaimResolved(
			id: number,
			claimToken: string,
			now: Date,
		): Promise<{ count: number }>;
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
		): Promise<{ count: number; requeued?: boolean }>;
		markClaimFailed(
			id: number,
			claimToken: string,
			error: unknown,
			now: Date,
			nextAttemptAt: Date,
		): Promise<{ count: number }>;
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
const CLAIM_RENEWAL_TIMEOUT_MS = 60 * 1000;
const STORAGE_REQUEST_TIMEOUT_MS = 60 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const NOISY_ATTEMPT_THRESHOLD = 10;

function assertOwnedMutation(
	result: { count: number },
	orphanId: number,
	action: string,
): void {
	if (result.count !== 1) {
		throw new Error(`Orphan deletion claim was lost before ${action} for orphan ${orphanId}`);
	}
}

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
		const failureWrites = await Promise.allSettled(pending.map(async (orphan) => {
			const backoffMs = Math.min(
				REAP_COOLDOWN_MS * (2 ** Math.min(orphan.attemptCount, 8)),
				MAX_BACKOFF_MS,
			);
			const result = await deps.repository.markClaimFailed(
				orphan.id,
				claimToken,
				error,
				now,
				new Date(now.getTime() + backoffMs),
			);
			assertOwnedMutation(result, orphan.id, 'failure requeue');
		}));
		const requeued = failureWrites.filter(({ status }) => status === 'fulfilled').length;
		deps.logger.error(
			{ error, claimed: pending.length, requeued },
			'Orphan reference snapshot failed; active claimed deletions were requeued',
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
		const renewOwnedClaim = async (): Promise<void> => {
			assertClaimOwned();
			if (operationSignal.aborted) {
				throw operationSignal.reason ?? new Error('Orphan reaper aborted');
			}
			renewalFlight ??= (async () => {
				const renewalDeadline = AbortSignal.timeout(CLAIM_RENEWAL_TIMEOUT_MS);
				const renewalSignal = AbortSignal.any([operationSignal, renewalDeadline]);
				let removeAbortListener = () => {};
				const aborted = new Promise<never>((_resolve, reject) => {
					const onAbort = () => {
						reject(renewalSignal.reason ?? new Error('Orphan claim renewal aborted'));
					};
					if (renewalSignal.aborted) {
						onAbort();
						return;
					}
					renewalSignal.addEventListener('abort', onAbort, { once: true });
					removeAbortListener = () => renewalSignal.removeEventListener('abort', onAbort);
				});
				// Promise.race installs both fulfillment and rejection handlers on the
				// database promise. A late result therefore remains observed but can no
				// longer authorize storage after this flight has timed out or aborted.
				let databaseRenewal: Promise<{ count: number }>;
				try {
					databaseRenewal = Promise.resolve(deps.repository.renewActiveClaim(
						orphan.id,
						claimToken,
						CLAIM_LEASE_MS,
					));
				} catch (error) {
					databaseRenewal = Promise.reject(error);
				}
				try {
					const result = await Promise.race([databaseRenewal, aborted]);
					if (renewalDeadline.aborted) {
						const error = renewalDeadline.reason ?? new Error('Orphan claim renewal timed out');
						loseClaim(error);
						throw claimLost ?? error;
					}
					if (operationSignal.aborted) {
						throw operationSignal.reason ?? new Error('Orphan reaper aborted');
					}
					if (result.count !== 1) {
						const error = new Error('Orphan deletion claim was lost');
						loseClaim(error);
						throw claimLost ?? error;
					}
				} catch (error) {
					if (renewalDeadline.aborted) {
						loseClaim(renewalDeadline.reason ?? error);
						throw claimLost ?? error;
					}
					if (operationSignal.aborted) {
						throw operationSignal.reason ?? error;
					}
					loseClaim(error);
					throw claimLost ?? error;
				} finally {
					removeAbortListener();
				}
			})().finally(() => {
				renewalFlight = undefined;
			});
			await renewalFlight;
		};
		heartbeat = setInterval(() => {
			void renewOwnedClaim().catch((error) => {
				deps.logger.error(
					{ error, orphanId: orphan.id },
					'Orphan deletion claim heartbeat failed',
				);
				// The renewal flight itself classifies repository/deadline failures as
				// claim loss. An outer operation abort stops the flight without being
				// relabelled as lost ownership here.
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
				assertOwnedMutation(cancellation, orphan.id, 'reference cancellation');
				if (cancellation.requeued === true) {
					continue;
				}
				resolved++;
				continue;
			}

			const assertOperationActive = () => {
				assertClaimOwned();
				if (operationSignal.aborted) {
					throw operationSignal.reason ?? new Error('Orphan reaper aborted');
				}
			};
			assertOperationActive();

			if (orphan.targetKind === 'PREFIX') {
				// Establish ownership once for the attempt. LIST pages are read-only and
				// only need the local heartbeat/abort fence; every destructive batch
				// still performs an authoritative renewal immediately before DELETE.
				await renewOwnedClaim();
				await deletePrefixPages({
					storage: deps.storage,
					bucket: orphan.bucket,
					prefix: orphan.storageKey,
					createRequest: () => boundedStorageRequest(operationSignal),
					beforeList: () => {
						assertOperationActive();
					},
					beforeDelete: async () => {
						await renewOwnedClaim();
						assertOperationActive();
					},
					onFailures: (failures) => {
						throw new Error(`S3 bulk delete returned ${failures.length} per-key failures`);
					},
				});
			} else {
				await renewOwnedClaim();
				assertOperationActive();
				const storageRequest = boundedStorageRequest(operationSignal);
				if (storageRequest.signal.aborted) {
					throw storageRequest.signal.reason ?? new Error('Orphan reaper aborted');
				}
				await deps.storage.delete(
					orphan.bucket,
					orphan.storageKey,
					storageRequest,
				);
				if (storageRequest.signal.aborted) {
					throw storageRequest.signal.reason ?? new Error('Orphan reaper aborted');
				}
			}
			assertOperationActive();
			const resolution = await deps.repository.markClaimResolved(orphan.id, claimToken, now);
			assertOwnedMutation(resolution, orphan.id, 'resolution');
			resolved++;
		} catch (err) {
			const backoffMs = Math.min(
				REAP_COOLDOWN_MS * (2 ** Math.min(orphan.attemptCount, 8)),
				MAX_BACKOFF_MS,
			);
			try {
				const failureWrite = await deps.repository.markClaimFailed(
					orphan.id,
					claimToken,
					err,
					now,
					new Date(now.getTime() + backoffMs),
				);
				assertOwnedMutation(failureWrite, orphan.id, 'failure requeue');
			} catch (dbErr) {
				deps.logger.error({ err: dbErr, orphanId: orphan.id }, 'Failed to record orphan reap attempt');
			}
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
