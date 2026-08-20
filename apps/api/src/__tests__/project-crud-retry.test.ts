import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import { createProjectCrudRepository } from '../modules/admin/project/crud.repository.js';

describe('project repository serializable retry', () => {
	it('retries the structured P2010/40001 emitted by the PostgreSQL driver adapter', async () => {
		const conflict = new Prisma.PrismaClientKnownRequestError('write conflict', {
			code: 'P2010',
			clientVersion: 'test',
			meta: {
				driverAdapterError: {
					cause: {
						kind: 'TransactionWriteConflict',
						originalCode: '40001',
					},
				},
			},
		});
		const tx = {
			$queryRaw: vi.fn()
				.mockResolvedValueOnce([{ id: 7, webglEntryKey: '' }])
				.mockResolvedValueOnce([]),
			gameUploadActiveSession: {
				findUnique: vi.fn(async () => null),
				deleteMany: vi.fn(async () => ({ count: 0 })),
			},
			gameUploadSession: {
				findMany: vi.fn(async () => []),
				updateMany: vi.fn(async () => ({ count: 0 })),
			},
			project: { update: vi.fn(async () => ({ id: 7 })) },
		};
		const transaction = vi.fn()
			.mockRejectedValueOnce(conflict)
			.mockImplementationOnce(async (operation: (value: typeof tx) => Promise<unknown>) => (
				operation(tx)
			));
		const repository = createProjectCrudRepository({ $transaction: transaction } as never);

		await expect(repository.clearWebglDeployment(7, {
			publicBucket: 'public',
			protectedBucket: 'protected',
			reason: 'test-clear',
		})).resolves.toEqual({ oldEntryKey: '', cancelledSession: null });
		expect(transaction).toHaveBeenCalledTimes(2);
		expect(transaction.mock.calls[1]?.[1]).toEqual({
			isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
		});
	});
});
