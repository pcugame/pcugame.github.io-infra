import { prisma } from '../../lib/prisma.js';

/**
 * Upsert a pending orphan record. If one already exists for (bucket, storageKey),
 * re-open it (clear resolvedAt, reset attemptCount) so the reaper picks it up again.
 * The reason string is replaced to reflect the latest call site.
 */
export function upsertOrphan(bucket: string, storageKey: string, reason: string) {
	return prisma.orphanObject.upsert({
		where: { orphan_bucket_storage_key: { bucket, storageKey } },
		create: { bucket, storageKey, reason },
		update: { reason, resolvedAt: null, attemptCount: 0, lastError: null },
	});
}

/** Pick up to `limit` pending orphans that haven't been tried in the last `cooldownMs` ms. */
export function findPendingOrphans(limit: number, cooldownMs: number) {
	const cutoff = new Date(Date.now() - cooldownMs);
	return prisma.orphanObject.findMany({
		where: {
			resolvedAt: null,
			OR: [{ lastTriedAt: null }, { lastTriedAt: { lt: cutoff } }],
		},
		orderBy: { id: 'asc' },
		take: limit,
	});
}

export function markResolved(id: number) {
	return prisma.orphanObject.update({
		where: { id },
		data: { resolvedAt: new Date() },
	});
}

export function markFailed(id: number, err: unknown) {
	return prisma.orphanObject.update({
		where: { id },
		data: {
			attemptCount: { increment: 1 },
			lastTriedAt: new Date(),
			lastError: String(err instanceof Error ? err.message : err).slice(0, 500),
		},
	});
}
