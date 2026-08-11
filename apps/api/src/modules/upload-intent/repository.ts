import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { assertNoDeletionClaim } from '../orphan/reference-resolver.js';
import { queueDurableDeletions } from '../orphan/outbox.js';
import type { NewUploadIntent } from './ports.js';

const SERIALIZABLE = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } as const;

export async function commitUploadIntents(
	tx: Prisma.TransactionClient,
	intentIds: readonly string[],
): Promise<void> {
	const uniqueIds = [...new Set(intentIds)];
	if (uniqueIds.length === 0) return;
	const intents = await tx.uploadIntent.findMany({
		where: {
			id: { in: uniqueIds },
			state: { in: ['PREPARED', 'UPLOADED'] },
		},
		select: { id: true, bucket: true, storageKey: true },
	});
	if (intents.length !== uniqueIds.length) {
		throw new Error(
			`Upload intent commit count mismatch: expected ${uniqueIds.length}, got ${intents.length}`,
		);
	}
	for (const intent of intents) {
		await assertNoDeletionClaim(tx, {
			bucket: intent.bucket,
			key: intent.storageKey,
			targetKind: 'EXACT',
		});
	}
	const result = await tx.uploadIntent.updateMany({
		where: {
			id: { in: uniqueIds },
			state: { in: ['PREPARED', 'UPLOADED'] },
		},
		data: {
			state: 'COMMITTED',
			claimToken: null,
			claimUntil: null,
			lastError: null,
		},
	});
	if (result.count !== uniqueIds.length) {
		throw new Error(
			`Upload intent commit count mismatch: expected ${uniqueIds.length}, got ${result.count}`,
		);
	}
}

export function createUploadIntentRepository(client: PrismaClient) {
	return {
		prepare(data: NewUploadIntent) {
			return client.$transaction(async (tx) => {
				await assertNoDeletionClaim(tx, { bucket: data.bucket, key: data.storageKey });
				return tx.uploadIntent.create({ data });
			}, SERIALIZABLE);
		},

		markUploaded(id: string) {
			return client.uploadIntent.updateMany({
				where: { id, state: 'PREPARED' },
				data: { state: 'UPLOADED', lastError: null },
			});
		},

		async isUncommitted(id: string): Promise<boolean> {
			const intent = await client.uploadIntent.findUnique({
				where: { id },
				select: { state: true },
			});
			return intent?.state === 'PREPARED' || intent?.state === 'UPLOADED';
		},

		recordAmbiguousError(id: string, error: unknown) {
			return client.uploadIntent.updateMany({
				where: { id, state: 'PREPARED' },
				data: {
					lastError: String(error instanceof Error ? error.message : error).slice(0, 500),
				},
			});
		},

		claimStale(limit: number, now: Date, claimToken: string, claimUntil: Date) {
			return client.$queryRaw<Array<{
				id: string;
				bucket: string;
				storageKey: string;
				state: 'PREPARED' | 'UPLOADED' | 'COMMITTED';
				attemptCount: number;
			}>>(Prisma.sql`
				WITH candidates AS (
					SELECT "id"
					FROM "upload_intents"
					WHERE "state" IN (
						'PREPARED'::"UploadIntentState",
						'UPLOADED'::"UploadIntentState"
					)
						AND "not_before" <= ${now}
						AND "next_attempt_at" <= ${now}
						AND ("claim_until" IS NULL OR "claim_until" <= ${now})
					ORDER BY "created_at"
					LIMIT ${limit}
					FOR UPDATE SKIP LOCKED
				)
				UPDATE "upload_intents" AS intent
				SET "claim_token" = ${claimToken}, "claim_until" = ${claimUntil}
				FROM candidates
				WHERE intent."id" = candidates."id"
				RETURNING intent."id",
					intent."bucket",
					intent."storage_key" AS "storageKey",
					intent."state"::text AS "state",
					intent."attempt_count" AS "attemptCount"
			`);
		},

		renewClaim(id: string, claimToken: string, now: Date, claimUntil: Date) {
			return client.uploadIntent.updateMany({
				where: {
					id,
					claimToken,
					claimUntil: { gt: now },
				},
				data: { claimUntil },
			});
		},

		markReferenced(id: string, claimToken: string) {
			return client.uploadIntent.updateMany({
				where: { id, claimToken },
				data: {
					state: 'COMMITTED',
					claimToken: null,
					claimUntil: null,
					lastError: null,
				},
			});
		},

		markMissing(id: string, claimToken: string) {
			return client.uploadIntent.updateMany({
				where: { id, claimToken },
				data: {
					state: 'RESOLVED',
					claimToken: null,
					claimUntil: null,
					lastError: null,
				},
			});
		},

		queueCleanup(id: string, claimToken: string, bucket: string, storageKey: string) {
			return client.$transaction(async (tx) => {
				const claimed = await tx.uploadIntent.findFirst({
					where: { id, claimToken },
					select: { id: true },
				});
				if (!claimed) return { count: 0 };
				await queueDurableDeletions(tx, [{
					bucket,
					storageKey,
					targetKind: 'EXACT',
					reason: 'stale-upload-intent',
				}]);
				return tx.uploadIntent.updateMany({
					where: { id, claimToken },
					data: {
						state: 'CLEANUP_QUEUED',
						claimToken: null,
						claimUntil: null,
					},
				});
			}, SERIALIZABLE);
		},

		markSweepFailed(
			id: string,
			claimToken: string,
			error: unknown,
			nextAttemptAt: Date,
		) {
			return client.uploadIntent.updateMany({
				where: { id, claimToken },
				data: {
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
