import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { OBJECT_REFERENCE_CLAIM_LOCK_ID } from './reference-resolver.js';
import { OUTBOX_REQUEUE_CANCEL_REASON } from './outbox.js';

type OrphanRepositoryClient = Pick<PrismaClient, 'orphanObject' | '$queryRaw'>;

export function createOrphanRepository(client: OrphanRepositoryClient) {
	return {
		upsertOrphan(
			bucket: string,
			storageKey: string,
			reason: string,
			targetKind: 'EXACT' | 'PREFIX' = storageKey.endsWith('/') ? 'PREFIX' : 'EXACT',
			now = new Date(),
		) {
			return (async () => {
				await client.orphanObject.upsert({
					where: { orphan_bucket_storage_key: { bucket, storageKey } },
					create: { bucket, storageKey, reason, targetKind, nextAttemptAt: now },
					update: { reason },
				});
				await client.orphanObject.updateMany({
					where: {
						bucket,
						storageKey,
						OR: [
							{ targetKind: { not: targetKind } },
							{ state: { not: 'DELETE_CLAIMED' } },
							{ claimUntil: null },
							{ claimUntil: { lte: now } },
						],
					},
					data: {
						targetKind,
						state: 'PENDING',
						claimToken: null,
						claimUntil: null,
						cancelReason: null,
						resolvedAt: null,
						attemptCount: 0,
						lastError: null,
						lastTriedAt: null,
						nextAttemptAt: now,
					},
				});
				return client.orphanObject.findUniqueOrThrow({
					where: { orphan_bucket_storage_key: { bucket, storageKey } },
				});
			})();
		},

		claimPendingOrphans: (limit: number, now: Date, claimUntil: Date, claimToken: string) => {
			return client.$queryRaw<Array<{
				id: number;
				bucket: string;
				storageKey: string;
				targetKind: 'EXACT' | 'PREFIX';
				attemptCount: number;
			}>>(Prisma.sql`
				WITH object_reference_lock AS MATERIALIZED (
					SELECT pg_advisory_xact_lock(${OBJECT_REFERENCE_CLAIM_LOCK_ID})
				), candidates AS (
					SELECT orphan."id"
					FROM "orphan_objects" AS orphan
					CROSS JOIN object_reference_lock
					WHERE orphan."next_attempt_at" <= ${now}
						AND (
							orphan."state" = 'PENDING'::"OrphanState"
							OR (
								orphan."state" = 'DELETE_CLAIMED'::"OrphanState"
								AND (orphan."claim_until" IS NULL OR orphan."claim_until" <= ${now})
							)
						)
					ORDER BY orphan."id"
					LIMIT ${limit}
					FOR UPDATE OF orphan SKIP LOCKED
				)
				UPDATE "orphan_objects" AS orphan
				SET "state" = 'DELETE_CLAIMED'::"OrphanState",
					"claim_token" = ${claimToken},
					"claim_until" = ${claimUntil},
					"cancel_reason" = NULL,
					"last_tried_at" = ${now}
				FROM candidates
				WHERE orphan."id" = candidates."id"
				RETURNING orphan."id",
					orphan."bucket",
					orphan."storage_key" AS "storageKey",
					orphan."target_kind"::text AS "targetKind",
					orphan."attempt_count" AS "attemptCount"
			`);
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
			return client.orphanObject.update({
				where: { id },
				data: {
					state: 'RESOLVED',
					resolvedAt: now,
					claimToken: null,
					claimUntil: null,
					cancelReason: null,
				},
			});
		},

		markClaimResolved(id: number, claimToken: string, now: Date) {
			return client.orphanObject.updateMany({
				where: { id, state: 'DELETE_CLAIMED', claimToken },
				data: {
					state: 'RESOLVED',
					resolvedAt: now,
					claimToken: null,
					claimUntil: null,
					cancelReason: null,
				},
			});
		},

		renewClaim(id: number, claimToken: string, now: Date, claimUntil: Date) {
			return client.orphanObject.updateMany({
				where: {
					id,
					state: 'DELETE_CLAIMED',
					claimToken,
					claimUntil: { gt: now },
				},
				data: { claimUntil },
			});
		},

		async markClaimCancelled(id: number, claimToken: string, reason: string, now: Date) {
			const requeued = await client.orphanObject.updateMany({
				where: {
					id,
					state: 'DELETE_CLAIMED',
					claimToken,
					cancelReason: OUTBOX_REQUEUE_CANCEL_REASON,
				},
				data: {
					state: 'PENDING',
					cancelReason: null,
					resolvedAt: null,
					claimToken: null,
					claimUntil: null,
					nextAttemptAt: now,
				},
			});
			if (requeued.count === 1) return { ...requeued, requeued: true };
			const cancelled = await client.orphanObject.updateMany({
				where: {
					id,
					state: 'DELETE_CLAIMED',
					claimToken,
					OR: [
						{ cancelReason: null },
						{ cancelReason: { not: OUTBOX_REQUEUE_CANCEL_REASON } },
					],
				},
				data: {
					state: 'CANCELLED',
					cancelReason: reason,
					resolvedAt: now,
					claimToken: null,
					claimUntil: null,
				},
			});
			if (cancelled.count === 1) return cancelled;
			// Close the only remaining race: a business outbox may have set the
			// requeue signal between the two conditional updates above.
			const racedRequeue = await client.orphanObject.updateMany({
				where: {
					id,
					state: 'DELETE_CLAIMED',
					claimToken,
					cancelReason: OUTBOX_REQUEUE_CANCEL_REASON,
				},
				data: {
					state: 'PENDING',
					cancelReason: null,
					resolvedAt: null,
					claimToken: null,
					claimUntil: null,
					nextAttemptAt: now,
				},
			});
			return { ...racedRequeue, requeued: racedRequeue.count === 1 };
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

		markClaimFailed(
			id: number,
			claimToken: string,
			err: unknown,
			now: Date,
			nextAttemptAt: Date,
		) {
			return client.orphanObject.updateMany({
				where: { id, state: 'DELETE_CLAIMED', claimToken },
				data: {
					state: 'PENDING',
					claimToken: null,
					claimUntil: null,
					cancelReason: null,
					attemptCount: { increment: 1 },
					lastTriedAt: now,
					nextAttemptAt,
					lastError: String(err instanceof Error ? err.message : err).slice(0, 500),
				},
			});
		},
	};
}
