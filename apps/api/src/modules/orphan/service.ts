import { createClaimToken } from '../../shared/claim-token.js';
import { deletePrefixPages } from '../../application/prefix-deletion.js';
import {
	createObjectReferenceIndex,
	type ObjectReferenceInventory,
} from './reference-resolver.js';
import { DEFAULT_ORPHAN_CLAIM_RENEWAL_POLICY } from './claim-renewal-policy.js';
import { createOrphanClaimLeaseGuard } from './claim-lease-guard.js';

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
			request?: { signal?: AbortSignal },
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
const CLAIM_RENEWAL_TIMEOUT_MS = DEFAULT_ORPHAN_CLAIM_RENEWAL_POLICY.jsDeadlineMs;
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
		const claim = createOrphanClaimLeaseGuard({
			outerSignal: signal,
			heartbeatMs: 30 * 1000,
			renewalDeadlineMs: CLAIM_RENEWAL_TIMEOUT_MS,
			ownershipLostError: () => new Error('Orphan deletion claim was lost'),
			renew: (renewalSignal) => deps.repository.renewActiveClaim(
				orphan.id,
				claimToken,
				CLAIM_LEASE_MS,
				{ signal: renewalSignal },
			),
			logHeartbeatFailure: (error) => {
				deps.logger.error(
					{ error, orphanId: orphan.id },
					'Orphan deletion claim heartbeat failed',
				);
			},
		});
		try {
			const referenced = referenceIndex.referencesTarget({
				bucket: orphan.bucket,
				targetKind: orphan.targetKind,
				key: orphan.storageKey,
			});
			claim.assertLeaseUsable();
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

			claim.assertOperationActive();

			if (orphan.targetKind === 'PREFIX') {
				// Establish ownership once for the attempt. LIST pages are read-only and
				// only need the local heartbeat/abort fence; every destructive batch
				// still performs an authoritative renewal immediately before DELETE.
				await claim.renewAndAssertOwned();
				await deletePrefixPages({
					storage: deps.storage,
					bucket: orphan.bucket,
					prefix: orphan.storageKey,
					createRequest: () => boundedStorageRequest(claim.signal),
					beforeList: () => {
						claim.assertOperationActive();
					},
					beforeDelete: async () => {
						await claim.renewAndAssertOwned();
						claim.assertOperationActive();
					},
					onFailures: (failures) => {
						throw new Error(`S3 bulk delete returned ${failures.length} per-key failures`);
					},
				});
			} else {
				await claim.renewAndAssertOwned();
				claim.assertOperationActive();
				const storageRequest = boundedStorageRequest(claim.signal);
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
			claim.assertOperationActive();
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
			claim.stop();
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
