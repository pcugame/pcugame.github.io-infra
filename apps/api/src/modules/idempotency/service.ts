import { AppError, idempotencyConflict, operationInProgress } from '../../shared/errors.js';
import { createClaimToken } from '../../shared/claim-token.js';
import type { IdempotencyRepository } from './ports.js';

const LEASE_MS = 2 * 60 * 1000;
const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

export function assertIdempotencyKey(value: unknown): string {
	if (typeof value !== 'string' || value.length < 1 || value.length > 200) {
		throw new AppError(
			400,
			'Idempotency-Key header must contain 1-200 characters',
			'VALIDATION_ERROR',
		);
	}
	return value;
}

export function createIdempotencyService(deps: {
	repository: IdempotencyRepository;
	clock: { now(): Date };
	ids?: { next(): string };
}) {
	const repository = deps.repository;
	return {
		async claim(input: { actorId: number; scope: string; key: string; requestHash: string }) {
			const now = deps.clock.now();
			const ownerToken = deps.ids?.next() ?? createClaimToken();
			const result = await repository.claim({
				id: deps.ids?.next() ?? createClaimToken(),
				...input,
				ownerToken,
				ownerUntil: new Date(now.getTime() + LEASE_MS),
				expiresAt: new Date(now.getTime() + EXPIRY_MS),
			}, now);
			if (result.kind === 'conflict') throw idempotencyConflict();
			if (result.kind === 'in_progress') throw operationInProgress();
			if (result.kind === 'terminal_failed') {
				throw new AppError(409, result.message, 'CONFLICT');
			}
			return result;
		},
		async renew(input: { operationId: string; ownerToken: string }): Promise<void> {
			const now = deps.clock.now();
			const renewed = await repository.renewOwnership({
				...input,
				now,
				ownerUntil: new Date(now.getTime() + LEASE_MS),
			});
			if (renewed.count !== 1) {
				throw new Error('Idempotency operation lease was lost');
			}
		},
		markFailed: (input: {
			operationId: string;
			ownerToken: string;
			terminal: boolean;
			error: unknown;
		}) => repository.markFailed(input).then(() => undefined),
		purgeExpired: (now: Date) => repository.purgeExpired(now),
	};
}
