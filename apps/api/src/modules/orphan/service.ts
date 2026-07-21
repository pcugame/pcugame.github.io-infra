export interface OrphanServiceDependencies {
	clock: { now(): Date };
	storage: { delete(bucket: string, key: string): Promise<void> };
	repository: {
		upsertOrphan(bucket: string, key: string, reason: string): Promise<unknown>;
		findPendingOrphans(limit: number, cutoff: Date): Promise<{
			id: number;
			bucket: string;
			storageKey: string;
			attemptCount: number;
		}[]>;
		markResolved(id: number, now: Date): Promise<unknown>;
		markFailed(id: number, error: unknown, now: Date): Promise<unknown>;
	};
	logger: {
		info(context: Record<string, unknown>, message: string): void;
		error(context: Record<string, unknown>, message: string): void;
	};
}

/**
 * Persist an S3 object that needs deleting. Never throws — if the DB write itself fails,
 * we log prominently so operators know the object is leaked until the next reconcile pass.
 */
export async function recordOrphan(
	deps: OrphanServiceDependencies,
	bucket: string,
	storageKey: string,
	reason: string,
): Promise<void> {
	try {
		await deps.repository.upsertOrphan(bucket, storageKey, reason);
	} catch (err) {
		deps.logger.error(
			{ err, bucket, storageKey, reason },
			'Failed to record orphan — S3 object will be leaked until reconcile-orphans runs',
		);
	}
}

const REAP_BATCH_SIZE = 50;
const REAP_COOLDOWN_MS = 5 * 60 * 1000;
const NOISY_ATTEMPT_THRESHOLD = 10;

/**
 * Pull a batch of pending orphans and retry their S3 delete. Intended to be called
 * by a periodic interval in server.ts. Safe to call concurrently — each row is updated
 * independently and upsert keeps the set idempotent.
 */
export async function runOrphanReaper(
	deps: OrphanServiceDependencies,
): Promise<{ tried: number; resolved: number; failed: number }> {
	const now = deps.clock.now();
	const pending = await deps.repository.findPendingOrphans(
		REAP_BATCH_SIZE,
		new Date(now.getTime() - REAP_COOLDOWN_MS),
	);
	if (pending.length === 0) return { tried: 0, resolved: 0, failed: 0 };

	let resolved = 0;
	let failed = 0;

	for (const orphan of pending) {
		try {
			await deps.storage.delete(orphan.bucket, orphan.storageKey);
			await deps.repository.markResolved(orphan.id, now);
			resolved++;
		} catch (err) {
			await deps.repository.markFailed(orphan.id, err, now).catch((dbErr) => {
				deps.logger.error({ err: dbErr, orphanId: orphan.id }, 'Failed to record orphan reap attempt');
			});
			if (orphan.attemptCount + 1 >= NOISY_ATTEMPT_THRESHOLD) {
				deps.logger.error(
					{ err, orphanId: orphan.id, bucket: orphan.bucket, storageKey: orphan.storageKey, attemptCount: orphan.attemptCount + 1 },
					'Orphan reap has failed repeatedly — manual intervention likely needed',
				);
			}
			failed++;
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
		runOrphanReaper: () => runOrphanReaper(deps),
	};
}
