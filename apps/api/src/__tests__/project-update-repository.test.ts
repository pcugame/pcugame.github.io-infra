import { describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { createProjectUpdateRepository } from '../modules/admin/project/update.repository.js';

describe('project update transaction contract', () => {
	it('preserves Prisma defaults and propagates transaction conflicts without adding automatic retries', async () => {
		const conflict = new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: 'test' });
		const transaction = vi.fn().mockRejectedValue(conflict);
		const repository = createProjectUpdateRepository({ $transaction: transaction } as unknown as PrismaClient);
		await expect(repository.runProjectUpdate(1, { id: 7, role: 'USER' }, vi.fn())).rejects.toBe(conflict);
		expect(transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function));
	});

	it('locks project, exhibition and membership in order before invoking policy and writes', async () => {
		const calls: string[] = [];
		const tx = {
			$queryRaw: async (sql: TemplateStringsArray) => {
				calls.push(sql.join('?').replace(/\s+/g, ' ').trim());
				return [{ id: 1 }];
			},
			project: { findUniqueOrThrow: async () => ({ creatorId: 7, status: 'PUBLISHED', exhibitionId: 2, changeRequestDraft: null }) },
			exhibition: { findUniqueOrThrow: async () => ({ isModificationEnabled: true }) },
		};
		const repository = createProjectUpdateRepository({ $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx) } as unknown as PrismaClient);
		await repository.runProjectUpdate(1, { id: 7, role: 'USER' }, async transaction => {
			expect(transaction.snapshot).toEqual({ creatorId: 7, status: 'PUBLISHED', isChangeRequestDraft: false, isModificationEnabled: true, isMember: true });
			expect(calls).toEqual([
				'SELECT id FROM projects WHERE id = ? FOR UPDATE',
				'SELECT id FROM exhibitions WHERE id = ? FOR UPDATE',
				'SELECT id FROM project_members WHERE project_id = ? AND user_id = ? FOR SHARE',
			]);
		});
	});
});
