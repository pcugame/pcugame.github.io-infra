import { describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { withAssetMutationTransaction } from './mutation-transaction.js';
import { withExhibitionMutationTransaction } from '../admin/year/repository.js';

function rawPostgresError(originalCode: string) {
	return new Prisma.PrismaClientKnownRequestError('Raw PostgreSQL failure', {
		code: 'P2010', clientVersion: 'test',
		meta: { driverAdapterError: { cause: { kind: 'postgres', originalCode } } },
	});
}

describe.each([
	['asset mutation', withAssetMutationTransaction],
	['exhibition mutation', withExhibitionMutationTransaction],
] as const)('%s raw deadlock retries', (_name, transaction) => {
	it('restarts a rolled back transaction after raw 40P01 and commits once', async () => {
		const run = vi.fn().mockRejectedValueOnce(rawPostgresError('40P01')).mockResolvedValueOnce('committed');
		const client = { $transaction: run } as unknown as Pick<PrismaClient, '$transaction'>;
		await expect(transaction(client, async () => 'committed')).resolves.toBe('committed');
		expect(run).toHaveBeenCalledTimes(2);
	});
	it('returns conflict after the existing bounded retry budget', async () => {
		const run = vi.fn().mockRejectedValue(rawPostgresError('40P01'));
		const client = { $transaction: run } as unknown as Pick<PrismaClient, '$transaction'>;
		await expect(transaction(client, async () => undefined)).rejects.toMatchObject({ statusCode: 409 });
		expect(run).toHaveBeenCalledTimes(3);
	});
	it('does not retry unrelated PostgreSQL check violations', async () => {
		const error = rawPostgresError('23514');
		const run = vi.fn().mockRejectedValue(error);
		const client = { $transaction: run } as unknown as Pick<PrismaClient, '$transaction'>;
		await expect(transaction(client, async () => undefined)).rejects.toBe(error);
		expect(run).toHaveBeenCalledTimes(1);
	});
});
