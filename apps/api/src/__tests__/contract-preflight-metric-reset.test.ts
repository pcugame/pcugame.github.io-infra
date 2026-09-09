import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import { createContractPreflightRepository } from '../modules/migration/contract-preflight.prisma.js';

describe('contract preflight observation reset', () => {
	it('locks producers and resets every scope before seeding baseline rows in one transaction', async () => {
		const executeRawUnsafe = vi.fn(async (_query: string) => 0);
		const executeRaw = vi.fn(async (_query: unknown) => 0);
		const tx = { $executeRawUnsafe: executeRawUnsafe, $executeRaw: executeRaw };
		const transaction = vi.fn(async (operation: (value: typeof tx) => Promise<void>, options: unknown) => {
			await operation(tx);
			expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
		});
		const repository = createContractPreflightRepository({ $transaction: transaction } as never);

		await repository.resetLegacyBridgeObservations(new Date('2026-08-24T00:00:00.000Z'));

		expect(executeRawUnsafe).toHaveBeenCalledWith('LOCK TABLE "migration_metrics" IN SHARE ROW EXCLUSIVE MODE');
		expect(executeRaw).toHaveBeenCalledTimes(2);
		const update = executeRaw.mock.calls[0]![0] as { strings: readonly string[] };
		const seed = executeRaw.mock.calls[1]![0] as { strings: readonly string[] };
		expect(update.strings.join('')).toContain('UPDATE "migration_metrics"');
		expect(update.strings.join('')).toContain('WHERE "name" IN');
		expect(update.strings.join('')).not.toContain('"scope" =');
		expect(seed.strings.join('')).toContain('INSERT INTO "migration_metrics"');
		expect(transaction).toHaveBeenCalledOnce();
	});
});
