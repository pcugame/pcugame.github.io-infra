import type { PrismaClient } from '../../generated/prisma/client.js';

export function createOrphanRepository(client: PrismaClient) {
	return {
		upsertOrphan(bucket: string, storageKey: string, reason: string) {
			return client.orphanObject.upsert({
				where: { orphan_bucket_storage_key: { bucket, storageKey } },
				create: { bucket, storageKey, reason },
				update: { reason, resolvedAt: null, attemptCount: 0, lastError: null },
			});
		},

		findPendingOrphans(limit: number, cutoff: Date) {
			return client.orphanObject.findMany({
				where: {
					resolvedAt: null,
					OR: [{ lastTriedAt: null }, { lastTriedAt: { lt: cutoff } }],
				},
				orderBy: { id: 'asc' },
				take: limit,
			});
		},

		markResolved(id: number, now: Date) {
			return client.orphanObject.update({ where: { id }, data: { resolvedAt: now } });
		},

		markFailed(id: number, err: unknown, now: Date) {
			return client.orphanObject.update({
				where: { id },
				data: {
					attemptCount: { increment: 1 },
					lastTriedAt: now,
					lastError: String(err instanceof Error ? err.message : err).slice(0, 500),
				},
			});
		},
	};
}
