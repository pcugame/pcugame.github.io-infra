export interface IdempotencyClaimInput {
	id: string;
	actorId: number;
	scope: string;
	key: string;
	requestHash: string;
	ownerToken: string;
	ownerLeaseMs: number;
	expiresAt: Date;
}

export type IdempotencyClaim =
	| { kind: 'acquired'; operationId: string; ownerToken: string }
	| { kind: 'succeeded'; result: unknown }
	| { kind: 'conflict' }
	| { kind: 'in_progress' }
	| { kind: 'terminal_failed'; message: string };

export interface IdempotencyRepository {
	claim(input: IdempotencyClaimInput): Promise<IdempotencyClaim>;
	renewOwnership(input: {
		operationId: string;
		ownerToken: string;
		leaseMs: number;
	}): Promise<{ count: number }>;
	markFailed(input: {
		operationId: string;
		ownerToken: string;
		terminal: boolean;
		error: unknown;
	}): Promise<unknown>;
	purgeExpired(now: Date): Promise<unknown>;
}
