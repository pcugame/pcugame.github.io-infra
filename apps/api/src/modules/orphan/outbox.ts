import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';

export interface DurableDeletionTarget {
	bucket: string;
	storageKey: string;
	reason: string;
	targetKind?: 'EXACT' | 'PREFIX';
}

type OrphanOutboxClient = Pick<PrismaClient, 'orphanObject' | '$queryRaw'>;

export const OUTBOX_REQUEUE_CANCEL_REASON = 'business-outbox-requeue-requested';

/**
 * Store cleanup intent in the caller's transaction. A trailing-slash key is a
 * prefix target and is re-enumerated by the orphan reaper on every attempt.
 */
export async function queueDurableDeletions(
	client: OrphanOutboxClient,
	targets: readonly DurableDeletionTarget[],
): Promise<void> {
	const now = new Date();
	const unique = new Map<string, DurableDeletionTarget>();
	for (const target of targets) {
		if (!target.storageKey) continue;
		unique.set(`${target.bucket}\0${target.storageKey}`, target);
	}
	for (const target of unique.values()) {
		const targetKind = target.targetKind
			?? (target.storageKey.endsWith('/') ? 'PREFIX' : 'EXACT');
		await client.orphanObject.upsert({
			where: {
				orphan_bucket_storage_key: {
					bucket: target.bucket,
					storageKey: target.storageKey,
				},
			},
			create: {
				...target,
				targetKind,
				nextAttemptAt: now,
			},
			update: { reason: target.reason },
		});
		// This helper runs inside the reference-removal transaction. Evaluate the
		// persisted lease once with the database clock: preserve and signal a live
		// owner, or atomically reset an inactive row for a future reaper claim.
		await client.$queryRaw(Prisma.sql`
			WITH database_time AS MATERIALIZED (
				SELECT clock_timestamp() AS "now"
			), classified AS MATERIALIZED (
				SELECT candidate."id",
					candidate."state" = 'DELETE_CLAIMED'::"OrphanState"
						AND candidate."claim_until" > database_time."now" AS "is_active"
				FROM "orphan_objects" AS candidate
				CROSS JOIN database_time
				WHERE candidate."bucket" = ${target.bucket}
					AND candidate."storage_key" = ${target.storageKey}
			)
			UPDATE "orphan_objects" AS orphan
			SET "target_kind" = CASE WHEN classified."is_active"
					THEN orphan."target_kind"
					ELSE CAST(${targetKind} AS "OrphanTargetKind")
				END,
				"state" = CASE WHEN classified."is_active"
					THEN orphan."state"
					ELSE 'PENDING'::"OrphanState"
				END,
				"claim_token" = CASE WHEN classified."is_active"
					THEN orphan."claim_token"
					ELSE NULL
				END,
				"claim_until" = CASE WHEN classified."is_active"
					THEN orphan."claim_until"
					ELSE NULL
				END,
				"cancel_reason" = CASE WHEN classified."is_active"
					THEN ${OUTBOX_REQUEUE_CANCEL_REASON}
					ELSE NULL
				END,
				"resolved_at" = CASE WHEN classified."is_active"
					THEN orphan."resolved_at"
					ELSE NULL
				END,
				"attempt_count" = CASE WHEN classified."is_active"
					THEN orphan."attempt_count"
					ELSE 0
				END,
				"last_tried_at" = CASE WHEN classified."is_active"
					THEN orphan."last_tried_at"
					ELSE NULL
				END,
				"last_error" = CASE WHEN classified."is_active"
					THEN orphan."last_error"
					ELSE NULL
				END,
				"next_attempt_at" = ${now}
			FROM classified
			WHERE orphan."id" = classified."id"
			RETURNING orphan."id"
		`);
	}
}
