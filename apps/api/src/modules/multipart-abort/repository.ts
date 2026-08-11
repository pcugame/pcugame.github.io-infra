import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import type { MultipartAbortTarget } from './ports.js';

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
		await tx.multipartAbortTask.updateMany({
			where: {
				id: task.id,
				OR: [
					{ state: { not: 'CLAIMED' } },
					{ claimUntil: null },
					{ claimUntil: { lte: now } },
				],
			},
			data: {
				state: 'PENDING',
				nextAttemptAt: now,
				claimToken: null,
				claimUntil: null,
				resolvedAt: null,
			},
		});
		return tx.multipartAbortTask.findUniqueOrThrow({ where: { id: task.id } });
	})();
}

export function createMultipartAbortRepository(client: PrismaClient) {
	return {
		queue(target: MultipartAbortTarget) {
			return client.$transaction((tx) => queueMultipartAbortTask(tx, target));
		},
		claim(limit: number, now: Date, claimToken: string, claimUntil: Date) {
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
					WHERE "next_attempt_at" <= ${now}
						AND (
							"state" = 'PENDING'::"MultipartAbortTaskState"
							OR (
								"state" = 'CLAIMED'::"MultipartAbortTaskState"
								AND ("claim_until" IS NULL OR "claim_until" <= ${now})
							)
						)
					ORDER BY "created_at"
					LIMIT ${limit}
					FOR UPDATE SKIP LOCKED
				)
				UPDATE "multipart_abort_tasks" AS task
				SET "state" = 'CLAIMED'::"MultipartAbortTaskState",
					"claim_token" = ${claimToken},
					"claim_until" = ${claimUntil}
				FROM candidates
				WHERE task."id" = candidates."id"
				RETURNING task."id",
					task."bucket",
					task."storage_key" AS "storageKey",
					task."upload_id" AS "uploadId",
					task."attempt_count" AS "attemptCount"
			`);
		},
		renew(id: string, claimToken: string, now: Date, claimUntil: Date) {
			return client.multipartAbortTask.updateMany({
				where: {
					id,
					state: 'CLAIMED',
					claimToken,
					claimUntil: { gt: now },
				},
				data: { claimUntil },
			});
		},
		resolve(id: string, claimToken: string, now: Date) {
			return client.multipartAbortTask.updateMany({
				where: { id, state: 'CLAIMED', claimToken },
				data: {
					state: 'RESOLVED',
					claimToken: null,
					claimUntil: null,
					resolvedAt: now,
					lastError: null,
				},
			});
		},
		fail(
			id: string,
			claimToken: string,
			error: unknown,
			nextAttemptAt: Date,
		) {
			return client.multipartAbortTask.updateMany({
				where: { id, state: 'CLAIMED', claimToken },
				data: {
					state: 'PENDING',
					claimToken: null,
					claimUntil: null,
					attemptCount: { increment: 1 },
					nextAttemptAt,
					lastError: String(error instanceof Error ? error.message : error).slice(0, 500),
				},
			});
		},
	};
}
