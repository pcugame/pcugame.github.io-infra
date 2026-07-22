import type { PrismaClient } from '../../generated/prisma/client.js';

export interface DurableDeletionTarget {
	bucket: string;
	storageKey: string;
	reason: string;
}

type OrphanOutboxClient = Pick<PrismaClient, 'orphanObject'>;

/**
 * Store cleanup intent in the caller's transaction. A trailing-slash key is a
 * prefix target and is re-enumerated by the orphan reaper on every attempt.
 */
export async function queueDurableDeletions(
	client: OrphanOutboxClient,
	targets: readonly DurableDeletionTarget[],
): Promise<void> {
	const unique = new Map<string, DurableDeletionTarget>();
	for (const target of targets) {
		if (!target.storageKey) continue;
		unique.set(`${target.bucket}\0${target.storageKey}`, target);
	}
	for (const target of unique.values()) {
		await client.orphanObject.upsert({
			where: {
				orphan_bucket_storage_key: {
					bucket: target.bucket,
					storageKey: target.storageKey,
				},
			},
			create: target,
			update: {
				reason: target.reason,
				resolvedAt: null,
				attemptCount: 0,
				lastTriedAt: null,
				lastError: null,
			},
		});
	}
}
