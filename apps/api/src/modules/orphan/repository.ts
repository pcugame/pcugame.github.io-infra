import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import {
	resolveOrphanClaimRenewalPolicy,
	type OrphanClaimRenewalPolicy,
} from './claim-renewal-policy.js';
import { OBJECT_REFERENCE_CLAIM_LOCK_ID } from './reference-resolver.js';
import { OUTBOX_REQUEUE_CANCEL_REASON } from './outbox.js';

type OrphanRepositoryClient = Pick<PrismaClient, 'orphanObject' | '$queryRaw' | '$transaction'>;

function assertRenewalActive(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw signal.reason ?? new Error('Orphan claim renewal aborted');
	}
}

export function createOrphanRepository(
	client: OrphanRepositoryClient,
	options: {
		claimRenewalPolicy?: Partial<Omit<OrphanClaimRenewalPolicy, 'jsDeadlineMs'>>;
	} = {},
) {
	const claimRenewalPolicy = resolveOrphanClaimRenewalPolicy(options.claimRenewalPolicy);
	return {
		async upsertOrphan(
			bucket: string,
			storageKey: string,
			reason: string,
			targetKind: 'EXACT' | 'PREFIX' = storageKey.endsWith('/') ? 'PREFIX' : 'EXACT',
			now = new Date(),
		) {
			await client.orphanObject.upsert({
				where: { orphan_bucket_storage_key: { bucket, storageKey } },
				create: { bucket, storageKey, reason, targetKind, nextAttemptAt: now },
				update: { reason },
			});
			// Reconciliation may reset an inactive row, but a live deletion owner
			// must remain fenced until PostgreSQL says its lease has expired.
			await client.$queryRaw(Prisma.sql`
				UPDATE "orphan_objects"
				SET "target_kind" = CAST(${targetKind} AS "OrphanTargetKind"),
					"state" = 'PENDING'::"OrphanState",
					"claim_token" = NULL,
					"claim_until" = NULL,
					"cancel_reason" = NULL,
					"resolved_at" = NULL,
					"attempt_count" = 0,
					"last_error" = NULL,
					"last_tried_at" = NULL,
					"next_attempt_at" = ${now}
				WHERE "bucket" = ${bucket}
					AND "storage_key" = ${storageKey}
					AND (
						"state" <> 'DELETE_CLAIMED'::"OrphanState"
						OR "claim_until" IS NULL
						OR "claim_until" <= clock_timestamp()
					)
				RETURNING "id"
			`);
			return client.orphanObject.findUniqueOrThrow({
				where: { orphan_bucket_storage_key: { bucket, storageKey } },
			});
		},

		claimPendingOrphans: (
			limit: number,
			eligibleAt: Date,
			claimToken: string,
			claimLeaseMs: number,
		) => {
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
					WHERE orphan."next_attempt_at" <= ${eligibleAt}
						AND (
							orphan."state" = 'PENDING'::"OrphanState"
							OR (
								orphan."state" = 'DELETE_CLAIMED'::"OrphanState"
								AND (
									orphan."claim_until" IS NULL
									OR orphan."claim_until" <= clock_timestamp()
								)
							)
						)
					ORDER BY orphan."id"
					LIMIT ${limit}
					FOR UPDATE OF orphan SKIP LOCKED
				)
				UPDATE "orphan_objects" AS orphan
				SET "state" = 'DELETE_CLAIMED'::"OrphanState",
					"claim_token" = ${claimToken},
					"claim_until" = clock_timestamp()
						+ (${claimLeaseMs} * INTERVAL '1 millisecond'),
					"cancel_reason" = NULL,
					"last_tried_at" = ${eligibleAt}
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

		async markClaimResolved(id: number, claimToken: string, now: Date) {
			const resolved = await client.$queryRaw<Array<{ id: number }>>(Prisma.sql`
				UPDATE "orphan_objects"
				SET "state" = 'RESOLVED'::"OrphanState",
					"resolved_at" = ${now},
					"claim_token" = NULL,
					"claim_until" = NULL,
					"cancel_reason" = NULL
				WHERE "id" = ${id}
					AND "state" = 'DELETE_CLAIMED'::"OrphanState"
					AND "claim_token" = ${claimToken}
					AND "claim_until" > clock_timestamp()
				RETURNING "id"
			`);
			return { count: resolved.length };
		},

		async renewActiveClaim(
			id: number,
			claimToken: string,
			claimLeaseMs: number,
			request?: { signal?: AbortSignal },
		) {
			return client.$transaction(async (tx) => {
				assertRenewalActive(request?.signal);
				await tx.$queryRaw(Prisma.sql`
					SELECT
						set_config(
							'statement_timeout',
							${`${claimRenewalPolicy.statementTimeoutMs}ms`},
							true
						) AS "statementTimeout",
						set_config(
							'idle_in_transaction_session_timeout',
							${`${claimRenewalPolicy.idleTransactionTimeoutMs}ms`},
							true
						) AS "idleTransactionTimeout"
				`);
				assertRenewalActive(request?.signal);
				const renewed = await tx.$queryRaw<Array<{ id: number }>>(Prisma.sql`
					WITH object_reference_lock AS MATERIALIZED (
						SELECT pg_advisory_xact_lock(${OBJECT_REFERENCE_CLAIM_LOCK_ID})
					), renewed AS (
						UPDATE "orphan_objects" AS orphan
						SET "claim_until" = clock_timestamp()
							+ (${claimLeaseMs} * INTERVAL '1 millisecond')
						FROM object_reference_lock
						WHERE orphan."id" = ${id}
							AND orphan."state" = 'DELETE_CLAIMED'::"OrphanState"
							AND orphan."claim_token" = ${claimToken}
							AND orphan."claim_until" > clock_timestamp()
						RETURNING orphan."id"
					)
					SELECT "id" FROM renewed
				`);
				// An abort observed before callback return must roll the UPDATE back;
				// only a committed transaction may report renewed ownership.
				assertRenewalActive(request?.signal);
				return { count: renewed.length };
			}, {
				maxWait: claimRenewalPolicy.transactionMaxWaitMs,
				timeout: claimRenewalPolicy.transactionTimeoutMs,
			});
		},

		async markClaimCancelled(id: number, claimToken: string, reason: string, now: Date) {
			const cancelled = await client.$queryRaw<Array<{ requeued: boolean }>>(Prisma.sql`
				WITH claimed AS MATERIALIZED (
					SELECT "id",
						"cancel_reason" = ${OUTBOX_REQUEUE_CANCEL_REASON} AS "requeue"
					FROM "orphan_objects"
					WHERE "id" = ${id}
						AND "state" = 'DELETE_CLAIMED'::"OrphanState"
						AND "claim_token" = ${claimToken}
						AND "claim_until" > clock_timestamp()
					FOR UPDATE
				)
				UPDATE "orphan_objects" AS orphan
				SET "state" = CASE WHEN claimed."requeue"
						THEN 'PENDING'::"OrphanState"
						ELSE 'CANCELLED'::"OrphanState"
					END,
					"cancel_reason" = CASE WHEN claimed."requeue" THEN NULL ELSE ${reason} END,
					"resolved_at" = CASE WHEN claimed."requeue"
						THEN NULL::timestamp
						ELSE CAST(${now} AS timestamp)
					END,
					"claim_token" = NULL,
					"claim_until" = NULL,
					"next_attempt_at" = CASE WHEN claimed."requeue"
						THEN ${now}
						ELSE orphan."next_attempt_at"
					END
				FROM claimed
				WHERE orphan."id" = claimed."id"
				RETURNING claimed."requeue" AS "requeued"
			`);
			return {
				count: cancelled.length,
				...(cancelled[0]?.requeued ? { requeued: true as const } : {}),
			};
		},

		async markClaimFailed(
			id: number,
			claimToken: string,
			err: unknown,
			now: Date,
			nextAttemptAt: Date,
		) {
			const failed = await client.$queryRaw<Array<{ id: number }>>(Prisma.sql`
				UPDATE "orphan_objects"
				SET "state" = 'PENDING'::"OrphanState",
					"claim_token" = NULL,
					"claim_until" = NULL,
					"cancel_reason" = NULL,
					"attempt_count" = "attempt_count" + 1,
					"last_tried_at" = ${now},
					"next_attempt_at" = ${nextAttemptAt},
					"last_error" = ${String(err instanceof Error ? err.message : err).slice(0, 500)}
				WHERE "id" = ${id}
					AND "state" = 'DELETE_CLAIMED'::"OrphanState"
					AND "claim_token" = ${claimToken}
					AND "claim_until" > clock_timestamp()
				RETURNING "id"
			`);
			return { count: failed.length };
		},
	};
}
