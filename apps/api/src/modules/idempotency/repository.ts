import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import type { IdempotencyClaim, IdempotencyClaimInput } from './ports.js';

export async function succeedIdempotencyOperation(
	tx: Prisma.TransactionClient,
	input: { operationId: string; ownerToken: string; result: unknown },
): Promise<void> {
	const updated = await tx.idempotencyOperation.updateMany({
		where: {
			id: input.operationId,
			state: 'IN_PROGRESS',
			ownerToken: input.ownerToken,
		},
		data: {
			state: 'SUCCEEDED',
			result: input.result as Prisma.InputJsonValue,
			ownerToken: null,
			ownerUntil: null,
			lastError: null,
		},
	});
	if (updated.count !== 1) {
		throw new Error('Idempotency operation lease was lost before commit');
	}
}

export function createIdempotencyRepository(client: PrismaClient) {
	return {
		async claim(input: IdempotencyClaimInput, now: Date): Promise<IdempotencyClaim> {
			const operation = await client.idempotencyOperation.upsert({
				where: {
					idempotency_actor_scope_key: {
						actorId: input.actorId,
						scope: input.scope,
						key: input.key,
					},
				},
				create: {
					id: input.id,
					actorId: input.actorId,
					scope: input.scope,
					key: input.key,
					requestHash: input.requestHash,
					ownerToken: input.ownerToken,
					ownerUntil: input.ownerUntil,
					expiresAt: input.expiresAt,
				},
				update: {},
			});

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
			if (operation.state === 'IN_PROGRESS' && operation.ownerUntil && operation.ownerUntil > now) {
				return { kind: 'in_progress' };
			}

			const acquired = await client.idempotencyOperation.updateMany({
				where: {
					id: operation.id,
					requestHash: input.requestHash,
					state: { in: ['IN_PROGRESS', 'RETRYABLE_FAILED'] },
					OR: [
						{ state: 'RETRYABLE_FAILED' },
						{ ownerUntil: null },
						{ ownerUntil: { lte: now } },
					],
				},
				data: {
					state: 'IN_PROGRESS',
					ownerToken: input.ownerToken,
					ownerUntil: input.ownerUntil,
					expiresAt: input.expiresAt,
					lastError: null,
				},
			});
			return acquired.count === 1
				? { kind: 'acquired', operationId: operation.id, ownerToken: input.ownerToken }
				: { kind: 'in_progress' };
		},

		renewOwnership(input: {
			operationId: string;
			ownerToken: string;
			now: Date;
			ownerUntil: Date;
		}) {
			return client.idempotencyOperation.updateMany({
				where: {
					id: input.operationId,
					state: 'IN_PROGRESS',
					ownerToken: input.ownerToken,
					ownerUntil: { gt: input.now },
				},
				data: { ownerUntil: input.ownerUntil },
			});
		},

		markFailed(input: {
			operationId: string;
			ownerToken: string;
			terminal: boolean;
			error: unknown;
		}) {
			return client.idempotencyOperation.updateMany({
				where: {
					id: input.operationId,
					state: 'IN_PROGRESS',
					ownerToken: input.ownerToken,
				},
				data: {
					state: input.terminal ? 'TERMINAL_FAILED' : 'RETRYABLE_FAILED',
					ownerToken: null,
					ownerUntil: null,
					lastError: String(input.error instanceof Error ? input.error.message : input.error).slice(0, 500),
				},
			});
		},

		purgeExpired(now: Date) {
			return client.idempotencyOperation.deleteMany({
				where: {
					expiresAt: { lte: now },
					OR: [
						{ state: { not: 'IN_PROGRESS' } },
						{ ownerUntil: null },
						{ ownerUntil: { lte: now } },
					],
				},
			});
		},
	};
}
