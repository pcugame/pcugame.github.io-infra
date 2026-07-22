import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createAssetsRepository } from '../modules/assets/repository.js';

describe('assets repository', () => {
	it('claims identity/status/storage and clears a matching poster in one transaction', async () => {
		const updateAsset = vi.fn().mockResolvedValue({ id: 42 });
		const updateProject = vi.fn().mockResolvedValue({ count: 1 });
		const tx = {
			asset: {
				findUnique: vi.fn().mockResolvedValue({ projectId: 7 }),
				update: updateAsset,
			},
			project: { updateMany: updateProject },
			$queryRaw: vi.fn()
				.mockResolvedValueOnce([{ id: 7 }])
				.mockResolvedValueOnce([{
					id: 42,
					projectId: 7,
					kind: 'POSTER',
					status: 'READY',
					storageKey: 'poster/current.png',
					playbackStorageKey: null,
				}]),
		};
		const repository = createAssetsRepository({
			$transaction: vi.fn(async (operation) => operation(tx)),
		} as unknown as PrismaClient);

		await expect(repository.claimAssetForDeletion(42)).resolves.toMatchObject({
			id: 42,
			previousStatus: 'READY',
			storageKey: 'poster/current.png',
		});
		expect(updateAsset).toHaveBeenCalledWith({
			where: { id: 42 },
			data: { status: 'DELETING' },
			select: { id: true },
		});
		expect(updateProject).toHaveBeenCalledWith({
			where: { id: 7, posterAssetId: 42 },
			data: { posterAssetId: null },
		});
	});

	it('terminalizes only the exact claimed storage identity', async () => {
		const updateMany = vi.fn().mockResolvedValue({ count: 1 });
		const repository = createAssetsRepository({
			asset: { updateMany },
		} as unknown as PrismaClient);
		const claim = {
			id: 42,
			projectId: 7,
			kind: 'POSTER' as const,
			previousStatus: 'READY' as const,
			storageKey: 'poster/current.png',
			playbackStorageKey: null,
			alreadyDeleted: false,
		};

		await repository.completeAssetDeletion(claim);

		expect(updateMany).toHaveBeenCalledWith({
			where: {
				id: 42,
				projectId: 7,
				kind: 'POSTER',
				status: 'DELETING',
				storageKey: 'poster/current.png',
				playbackStorageKey: null,
			},
			data: { status: 'DELETED' },
		});
	});
});
