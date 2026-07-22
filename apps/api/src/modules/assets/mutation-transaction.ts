import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { conflict } from '../../shared/errors.js';

type TransactionClient = Prisma.TransactionClient;
type TransactionHost = Pick<PrismaClient, '$transaction'>;

export interface AssetMutationTransactionPolicy {
	readonly isolationLevel: typeof Prisma.TransactionIsolationLevel.Serializable;
	readonly maxAttempts: number;
}

/**
 * Asset identity and project-pointer mutations use the same bounded policy.
 * Keeping the policy in the repository API makes contention behaviour visible
 * to callers and prevents an accidental unbounded retry loop.
 */
export const ASSET_MUTATION_TRANSACTION_POLICY: AssetMutationTransactionPolicy = Object.freeze({
	isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
	maxAttempts: 3,
});

function isRetryableAssetMutationError(error: unknown): boolean {
	if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
	if (error.code === 'P2034' || error.code === 'P2002') return true;
	if (error.code !== 'P2010') return false;

	// Prisma's PostgreSQL driver adapter reports a 40001 raised by raw
	// `SELECT ... FOR UPDATE` as P2010 instead of P2034. Match the exact
	// structured cause; unrelated raw-query failures are never retried.
	const driverError = error.meta?.['driverAdapterError'];
	if (!driverError || typeof driverError !== 'object' || !('cause' in driverError)) return false;
	const cause = driverError.cause;
	return !!cause
		&& typeof cause === 'object'
		&& 'kind' in cause
		&& cause.kind === 'TransactionWriteConflict'
		&& 'originalCode' in cause
		&& cause.originalCode === '40001';
}

export async function withAssetMutationTransaction<T>(
	client: TransactionHost,
	operation: (tx: TransactionClient) => Promise<T>,
	policy: AssetMutationTransactionPolicy = ASSET_MUTATION_TRANSACTION_POLICY,
): Promise<T> {
	if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
		throw new RangeError('Asset mutation maxAttempts must be a positive integer');
	}

	for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
		try {
			return await client.$transaction(operation, {
				isolationLevel: policy.isolationLevel,
			});
		} catch (error) {
			if (!isRetryableAssetMutationError(error)) throw error;
			if (attempt === policy.maxAttempts) {
				throw conflict('Asset changed concurrently; retry the request');
			}
		}
	}

	// The validated positive bound and loop returns/throws on every attempt.
	throw new Error('Asset mutation retry policy exhausted unexpectedly');
}
