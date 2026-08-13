import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import type { IdempotencyClaim, IdempotencyClaimInput } from './ports.js';

export async function succeedIdempotencyOperation(
	tx: Prisma.TransactionClient,
	input: { operationId: string; ownerToken: string; result: unknown },
): Promise<void> {
	const serializedResult = JSON.stringify(input.result);
	if (serializedResult === undefined) {
		throw new Error('Idempotency operation result must be JSON-serializable');
	}
	const updated = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
		UPDATE "idempotency_operations"
		SET "state" = 'SUCCEEDED'::"IdempotencyOperationState",
			"result" = ${serializedResult}::jsonb,
			"owner_token" = NULL,
			"owner_until" = NULL,
			"last_error" = NULL,
			"updated_at" = clock_timestamp()
		WHERE "id" = ${input.operationId}
			AND "state" = 'IN_PROGRESS'::"IdempotencyOperationState"
			AND "owner_token" = ${input.ownerToken}
			AND "owner_until" > clock_timestamp()
		RETURNING "id"
	`);
	if (updated.length !== 1) {
		throw new Error('Idempotency operation lease was lost before commit');
	}
}

export function createIdempotencyRepository(client: PrismaClient) {
	return {
		async claim(input: IdempotencyClaimInput): Promise<IdempotencyClaim> {
			// Keeping this predicate in one fragment prevents the state/token/deadline
			// CASE expressions from drifting apart. database_time is materialized by
			// the statement below, so every interpolation observes the same instant.
			const canTakeOver = Prisma.sql`
				"idempotency_operations"."request_hash" = EXCLUDED."request_hash"
				AND "idempotency_operations"."state" IN (
					'IN_PROGRESS'::"IdempotencyOperationState",
					'RETRYABLE_FAILED'::"IdempotencyOperationState"
				)
				AND (
					"idempotency_operations"."state" = 'RETRYABLE_FAILED'::"IdempotencyOperationState"
					OR "idempotency_operations"."owner_until" IS NULL
					OR "idempotency_operations"."owner_until" <= (
						SELECT database_time."claimed_at" FROM database_time
					)
				)
			`;
			const [operation] = await client.$queryRaw<Array<{
				id: string;
				requestHash: string;
				state: 'IN_PROGRESS' | 'SUCCEEDED' | 'RETRYABLE_FAILED' | 'TERMINAL_FAILED';
				ownerToken: string | null;
				result: unknown;
				lastError: string | null;
			}>>(Prisma.sql`
				WITH database_time AS MATERIALIZED (
					SELECT clock_timestamp() AS "claimed_at"
				)
				INSERT INTO "idempotency_operations" (
					"id", "actor_id", "scope", "key", "request_hash", "state",
					"owner_token", "owner_until", "expires_at", "created_at", "updated_at"
				)
				SELECT
					${input.id}, ${input.actorId}, ${input.scope}, ${input.key}, ${input.requestHash},
					'IN_PROGRESS'::"IdempotencyOperationState", ${input.ownerToken},
					database_time."claimed_at" + (${input.ownerLeaseMs} * INTERVAL '1 millisecond'),
					${input.expiresAt}, database_time."claimed_at", database_time."claimed_at"
				FROM database_time
				ON CONFLICT ("actor_id", "scope", "key") DO UPDATE SET
					"state" = CASE WHEN ${canTakeOver}
					THEN 'IN_PROGRESS'::"IdempotencyOperationState"
					ELSE "idempotency_operations"."state" END,
					"owner_token" = CASE WHEN ${canTakeOver}
					THEN EXCLUDED."owner_token"
					ELSE "idempotency_operations"."owner_token" END,
					"owner_until" = CASE WHEN ${canTakeOver}
					THEN EXCLUDED."owner_until"
					ELSE "idempotency_operations"."owner_until" END,
					"expires_at" = CASE WHEN ${canTakeOver}
					THEN EXCLUDED."expires_at"
					ELSE "idempotency_operations"."expires_at" END,
					"last_error" = CASE WHEN ${canTakeOver}
					THEN NULL ELSE "idempotency_operations"."last_error" END,
					"updated_at" = CASE WHEN ${canTakeOver}
					THEN EXCLUDED."updated_at" ELSE "idempotency_operations"."updated_at" END
				RETURNING "id", "request_hash" AS "requestHash", "state"::text AS "state",
					"owner_token" AS "ownerToken", "result", "last_error" AS "lastError"
			`);
			if (!operation) throw new Error('Idempotency claim did not return an operation');

			if (operation.requestHash !== input.requestHash) return { kind: 'conflict' };
			if (operation.state === 'SUCCEEDED') {
				return { kind: 'succeeded', result: operation.result };
			}
			if (operation.state === 'TERMINAL_FAILED') {
				return {
					kind: 'terminal_failed',
					message: operation.lastError ?? 'The original operation failed validation',
				};
			}
			if (operation.ownerToken === input.ownerToken) {
				return { kind: 'acquired', operationId: operation.id, ownerToken: input.ownerToken };
			}
			return { kind: 'in_progress' };
		},

		renewOwnership(input: {
			operationId: string;
			ownerToken: string;
			leaseMs: number;
		}) {
			return client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				UPDATE "idempotency_operations"
				SET "owner_until" = clock_timestamp()
						+ (${input.leaseMs} * INTERVAL '1 millisecond'),
					"updated_at" = clock_timestamp()
				WHERE "id" = ${input.operationId}
					AND "state" = 'IN_PROGRESS'::"IdempotencyOperationState"
					AND "owner_token" = ${input.ownerToken}
					AND "owner_until" > clock_timestamp()
				RETURNING "id"
			`).then((renewed) => ({ count: renewed.length }));
		},

		async markFailed(input: {
			operationId: string;
			ownerToken: string;
			terminal: boolean;
			error: unknown;
		}) {
			const state = input.terminal ? 'TERMINAL_FAILED' : 'RETRYABLE_FAILED';
			const message = String(
				input.error instanceof Error ? input.error.message : input.error,
			).slice(0, 500);
			const updated = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				UPDATE "idempotency_operations"
				SET "state" = CAST(${state} AS "IdempotencyOperationState"),
					"owner_token" = NULL,
					"owner_until" = NULL,
					"last_error" = ${message},
					"updated_at" = clock_timestamp()
				WHERE "id" = ${input.operationId}
					AND "state" = 'IN_PROGRESS'::"IdempotencyOperationState"
					AND "owner_token" = ${input.ownerToken}
					AND "owner_until" > clock_timestamp()
				RETURNING "id"
			`);
			if (updated.length !== 1) {
				throw new Error('Idempotency operation lease was lost before failure update');
			}
			return { count: 1 };
		},

		async purgeExpired(now: Date) {
			const deleted = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				DELETE FROM "idempotency_operations"
				WHERE "expires_at" <= ${now}
					AND (
						"state" <> 'IN_PROGRESS'::"IdempotencyOperationState"
						OR "owner_until" IS NULL
						OR "owner_until" <= clock_timestamp()
					)
				RETURNING "id"
			`);
			return { count: deleted.length };
		},
	};
}
