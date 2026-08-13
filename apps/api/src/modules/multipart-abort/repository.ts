import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import type { MultipartAbortTarget } from './ports.js';

function requireActiveClaim(updated: readonly { id: string }[]): { count: number } {
	if (updated.length !== 1) throw new Error('Multipart abort task claim was lost');
	return { count: 1 };
}

export function queueMultipartAbortTask(
	tx: Prisma.TransactionClient,
	target: MultipartAbortTarget,
	now = new Date(),
) {
	return (async () => {
		const task = await tx.multipartAbortTask.upsert({
			where: {
				multipart_abort_bucket_key_upload: {
					bucket: target.bucket,
					storageKey: target.storageKey,
					uploadId: target.uploadId,
				},
			},
			create: { ...target, nextAttemptAt: now },
			update: { reason: target.reason },
		});
		await tx.$queryRaw(Prisma.sql`
			UPDATE "multipart_abort_tasks"
			SET "state" = 'PENDING'::"MultipartAbortTaskState",
				"next_attempt_at" = ${now},
				"claim_token" = NULL,
				"claim_until" = NULL,
				"resolved_at" = NULL,
				"updated_at" = clock_timestamp()
			WHERE "id" = ${task.id}
				AND (
					"state" <> 'CLAIMED'::"MultipartAbortTaskState"
					OR "claim_until" IS NULL
					OR "claim_until" <= clock_timestamp()
				)
			RETURNING "id"
		`);
		return tx.multipartAbortTask.findUniqueOrThrow({ where: { id: task.id } });
	})();
}

export function createMultipartAbortRepository(client: PrismaClient) {
	return {
		queue(target: MultipartAbortTarget) {
			return client.$transaction((tx) => queueMultipartAbortTask(tx, target));
		},
		claim(limit: number, claimToken: string, claimLeaseMs: number) {
			return client.$queryRaw<Array<{
				id: string;
				bucket: string;
				storageKey: string;
				uploadId: string;
				attemptCount: number;
			}>>(Prisma.sql`
				WITH candidates AS (
					SELECT "id"
					FROM "multipart_abort_tasks"
					WHERE "next_attempt_at" <= clock_timestamp()
						AND (
							"state" = 'PENDING'::"MultipartAbortTaskState"
							OR (
								"state" = 'CLAIMED'::"MultipartAbortTaskState"
								AND ("claim_until" IS NULL OR "claim_until" <= clock_timestamp())
							)
						)
					ORDER BY "created_at"
					LIMIT ${limit}
					FOR UPDATE SKIP LOCKED
				)
				UPDATE "multipart_abort_tasks" AS task
				SET "state" = 'CLAIMED'::"MultipartAbortTaskState",
					"claim_token" = ${claimToken},
					"claim_until" = clock_timestamp()
						+ (${claimLeaseMs} * INTERVAL '1 millisecond')
				FROM candidates
				WHERE task."id" = candidates."id"
				RETURNING task."id",
					task."bucket",
					task."storage_key" AS "storageKey",
					task."upload_id" AS "uploadId",
					task."attempt_count" AS "attemptCount"
			`);
		},
		async renew(id: string, claimToken: string, claimLeaseMs: number) {
			const renewed = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				UPDATE "multipart_abort_tasks"
				SET "claim_until" = clock_timestamp()
						+ (${claimLeaseMs} * INTERVAL '1 millisecond'),
					"updated_at" = clock_timestamp()
				WHERE "id" = ${id}
					AND "state" = 'CLAIMED'::"MultipartAbortTaskState"
					AND "claim_token" = ${claimToken}
					AND "claim_until" > clock_timestamp()
				RETURNING "id"
			`);
			return { count: renewed.length };
		},
		async resolve(id: string, claimToken: string, now: Date) {
			const updated = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				UPDATE "multipart_abort_tasks"
				SET "state" = 'RESOLVED'::"MultipartAbortTaskState",
					"claim_token" = NULL,
					"claim_until" = NULL,
					"resolved_at" = ${now},
					"last_error" = NULL,
					"updated_at" = clock_timestamp()
				WHERE "id" = ${id}
					AND "state" = 'CLAIMED'::"MultipartAbortTaskState"
					AND "claim_token" = ${claimToken}
					AND "claim_until" > clock_timestamp()
				RETURNING "id"
			`);
			return requireActiveClaim(updated);
		},
		async fail(
			id: string,
			claimToken: string,
			error: unknown,
			nextAttemptAt: Date,
		) {
			const message = String(error instanceof Error ? error.message : error).slice(0, 500);
			const updated = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				UPDATE "multipart_abort_tasks"
				SET "state" = 'PENDING'::"MultipartAbortTaskState",
					"claim_token" = NULL,
					"claim_until" = NULL,
					"attempt_count" = "attempt_count" + 1,
					"next_attempt_at" = ${nextAttemptAt},
					"last_error" = ${message},
					"updated_at" = clock_timestamp()
				WHERE "id" = ${id}
					AND "state" = 'CLAIMED'::"MultipartAbortTaskState"
					AND "claim_token" = ${claimToken}
					AND "claim_until" > clock_timestamp()
				RETURNING "id"
			`);
			return requireActiveClaim(updated);
		},
	};
}
