import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { assertNoDeletionClaim } from '../orphan/reference-resolver.js';
import { queueDurableDeletions } from '../orphan/outbox.js';
import type { NewUploadIntent } from './ports.js';

const SERIALIZABLE = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } as const;

function requireActiveClaim(updated: readonly { id: string }[]): { count: number } {
	if (updated.length !== 1) throw new Error('Upload intent claim was lost');
	return { count: 1 };
}

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
				const existing = await tx.uploadIntent.findUnique({
					where: {
						upload_intent_bucket_storage_key: {
							bucket: data.bucket,
							storageKey: data.storageKey,
						},
					},
					select: {
						id: true,
						state: true,
						purpose: true,
						ownerOperationId: true,
						ownerActorId: true,
						ownerProjectId: true,
						ownerExhibitionId: true,
					},
				});
				if (!existing) return tx.uploadIntent.create({ data });
				const sameOwner = existing.purpose === data.purpose
					&& existing.ownerOperationId === (data.ownerOperationId ?? null)
					&& existing.ownerActorId === (data.ownerActorId ?? null)
					&& existing.ownerProjectId === (data.ownerProjectId ?? null)
					&& existing.ownerExhibitionId === (data.ownerExhibitionId ?? null);
				if (!sameOwner) {
					throw new Error('Upload intent object key is owned by another operation');
				}
				if (existing.state !== 'RESOLVED') {
					// A deterministic rendition key belongs to immutable bytes. Sharing an
					// active/committed intent would let a loser issue a second PUT, while a
					// cleanup-queued intent may already have an outbox claim in flight.
					throw new Error(
						`Upload intent already owns object key in state ${existing.state}`,
					);
				}
				// Deterministic rendition retries reuse an exact object key. A terminal
				// attempt may be rearmed only after proving no deletion claim is active.
				return tx.uploadIntent.update({
					where: { id: existing.id },
					data: {
						purpose: data.purpose,
						ownerOperationId: data.ownerOperationId,
						ownerActorId: data.ownerActorId,
						ownerProjectId: data.ownerProjectId,
						ownerExhibitionId: data.ownerExhibitionId,
						notBefore: data.notBefore,
						state: 'PREPARED',
						attemptCount: 0,
						nextAttemptAt: new Date(),
						lastError: null,
						claimToken: null,
						claimUntil: null,
					},
				});
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

		claimStale(limit: number, claimToken: string, claimLeaseMs: number) {
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
						AND "not_before" <= clock_timestamp()
						AND "next_attempt_at" <= clock_timestamp()
						AND ("claim_until" IS NULL OR "claim_until" <= clock_timestamp())
					ORDER BY "created_at"
					LIMIT ${limit}
					FOR UPDATE SKIP LOCKED
				)
				UPDATE "upload_intents" AS intent
				SET "claim_token" = ${claimToken},
					"claim_until" = clock_timestamp()
						+ (${claimLeaseMs} * INTERVAL '1 millisecond')
				FROM candidates
				WHERE intent."id" = candidates."id"
				RETURNING intent."id",
					intent."bucket",
					intent."storage_key" AS "storageKey",
					intent."state"::text AS "state",
					intent."attempt_count" AS "attemptCount"
			`);
		},

		async renewClaim(id: string, claimToken: string, claimLeaseMs: number) {
			const renewed = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				UPDATE "upload_intents"
				SET "claim_until" = clock_timestamp()
						+ (${claimLeaseMs} * INTERVAL '1 millisecond'),
					"updated_at" = clock_timestamp()
				WHERE "id" = ${id}
					AND "claim_token" = ${claimToken}
					AND "claim_until" > clock_timestamp()
				RETURNING "id"
			`);
			return { count: renewed.length };
		},

		async markReferenced(id: string, claimToken: string) {
			const updated = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				UPDATE "upload_intents"
				SET "state" = 'COMMITTED'::"UploadIntentState",
					"claim_token" = NULL,
					"claim_until" = NULL,
					"last_error" = NULL,
					"updated_at" = clock_timestamp()
				WHERE "id" = ${id}
					AND "claim_token" = ${claimToken}
					AND "claim_until" > clock_timestamp()
				RETURNING "id"
			`);
			return requireActiveClaim(updated);
		},

		async markMissing(id: string, claimToken: string) {
			const updated = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				UPDATE "upload_intents"
				SET "state" = 'RESOLVED'::"UploadIntentState",
					"claim_token" = NULL,
					"claim_until" = NULL,
					"last_error" = NULL,
					"updated_at" = clock_timestamp()
				WHERE "id" = ${id}
					AND "claim_token" = ${claimToken}
					AND "claim_until" > clock_timestamp()
				RETURNING "id"
			`);
			return requireActiveClaim(updated);
		},

		queueCleanup(id: string, claimToken: string, bucket: string, storageKey: string) {
			return client.$transaction(async (tx) => {
				const updated = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
					UPDATE "upload_intents"
					SET "state" = 'CLEANUP_QUEUED'::"UploadIntentState",
						"claim_token" = NULL,
						"claim_until" = NULL,
						"updated_at" = clock_timestamp()
					WHERE "id" = ${id}
						AND "claim_token" = ${claimToken}
						AND "claim_until" > clock_timestamp()
					RETURNING "id"
				`);
				requireActiveClaim(updated);
				await queueDurableDeletions(tx, [{
					bucket,
					storageKey,
					targetKind: 'EXACT',
					reason: 'stale-upload-intent',
				}]);
				return { count: 1 };
			}, SERIALIZABLE);
		},

		async markSweepFailed(
			id: string,
			claimToken: string,
			error: unknown,
			nextAttemptAt: Date,
		) {
			const message = String(error instanceof Error ? error.message : error).slice(0, 500);
			const updated = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				UPDATE "upload_intents"
				SET "claim_token" = NULL,
					"claim_until" = NULL,
					"attempt_count" = "attempt_count" + 1,
					"next_attempt_at" = ${nextAttemptAt},
					"last_error" = ${message},
					"updated_at" = clock_timestamp()
				WHERE "id" = ${id}
					AND "claim_token" = ${claimToken}
					AND "claim_until" > clock_timestamp()
				RETURNING "id"
			`);
			return requireActiveClaim(updated);
		},
	};
}
