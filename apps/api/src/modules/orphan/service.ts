import { deleteObject } from '../../lib/storage.js';
import { logger } from '../../lib/logger.js';
import * as repo from './repository.js';

/**
 * Persist an S3 object that needs deleting. Never throws — if the DB write itself fails,
 * we log prominently so operators know the object is leaked until the next reconcile pass.
 */
export async function recordOrphan(bucket: string, storageKey: string, reason: string): Promise<void> {
	try {
		await repo.upsertOrphan(bucket, storageKey, reason);
	} catch (err) {
		logger().error(
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
export async function runOrphanReaper(): Promise<{ tried: number; resolved: number; failed: number }> {
	const pending = await repo.findPendingOrphans(REAP_BATCH_SIZE, REAP_COOLDOWN_MS);
	if (pending.length === 0) return { tried: 0, resolved: 0, failed: 0 };

	let resolved = 0;
	let failed = 0;

	for (const orphan of pending) {
		try {
			await deleteObject(orphan.bucket, orphan.storageKey);
			await repo.markResolved(orphan.id);
			resolved++;
		} catch (err) {
			await repo.markFailed(orphan.id, err).catch((dbErr) => {
				logger().error({ err: dbErr, orphanId: orphan.id }, 'Failed to record orphan reap attempt');
			});
			if (orphan.attemptCount + 1 >= NOISY_ATTEMPT_THRESHOLD) {
				logger().error(
					{ err, orphanId: orphan.id, bucket: orphan.bucket, storageKey: orphan.storageKey, attemptCount: orphan.attemptCount + 1 },
					'Orphan reap has failed repeatedly — manual intervention likely needed',
				);
			}
			failed++;
		}
	}

	logger().info({ tried: pending.length, resolved, failed }, 'Orphan reaper batch complete');
	return { tried: pending.length, resolved, failed };
}
