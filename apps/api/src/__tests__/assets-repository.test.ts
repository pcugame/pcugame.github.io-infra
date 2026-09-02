import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createAssetsRepository } from '../modules/assets/repository.js';

const original = {
	id: 'rep-original', role: 'ORIGINAL', bucket: 'protected',
	objectKey: 'protected/assets/42/original/g1.zip', updatedAt: new Date(1), checksum: 'sha256',
};

describe('assets repository', () => {
	it('claims the canonical representation fence and clears a matching poster atomically', async () => {
		const updateAsset = vi.fn().mockResolvedValue({ id: 42 });
		const updateProject = vi.fn().mockResolvedValue({ count: 1 });
		const tx = {
			asset: { findUnique: vi.fn().mockResolvedValue({ projectId: 7 }), update: updateAsset },
			project: { updateMany: updateProject },
			$queryRaw: vi.fn()
				.mockResolvedValueOnce([{ id: 7 }])
				.mockResolvedValueOnce([{ id: 42, projectId: 7, kind: 'POSTER', status: 'READY' }])
				.mockResolvedValueOnce([original]),
		};
		const repository = createAssetsRepository({
			$transaction: vi.fn(async (operation) => operation(tx)),
		} as unknown as PrismaClient);

		await expect(repository.claimAssetForDeletion(42)).resolves.toMatchObject({
			id: 42,
			previousStatus: 'READY',
			representations: [original],
		});
		expect(updateAsset).toHaveBeenCalledWith({
			where: { id: 42 }, data: { status: 'DELETING' }, select: { id: true },
		});
		expect(updateProject).toHaveBeenCalledWith({
			where: { id: 7, posterAssetId: 42 }, data: { posterAssetId: null },
		});
	});

	it('terminalizes only an unchanged representation fence and queues each physical object', async () => {
		const updateMany = vi.fn().mockResolvedValue({ count: 1 });
		const orphanUpsert = vi.fn().mockResolvedValue({});
		const tx = {
			$queryRaw: vi.fn()
				.mockResolvedValueOnce([{ id: 7 }])
				.mockResolvedValueOnce([{ id: 42, projectId: 7, kind: 'GAME', status: 'DELETING' }])
				.mockResolvedValueOnce([original])
				.mockResolvedValue([]),
			asset: { updateMany },
			orphanObject: { upsert: orphanUpsert },
		};
		const repository = createAssetsRepository({
			$transaction: vi.fn(async (operation) => operation(tx)),
		} as unknown as PrismaClient);

		await repository.completeAssetDeletion({
			id: 42, projectId: 7, kind: 'GAME', previousStatus: 'READY',
			representations: [original], alreadyDeleted: false,
		}, { reason: 'asset-delete' });

		expect(updateMany).toHaveBeenCalledWith({
			where: { id: 42, projectId: 7, kind: 'GAME', status: 'DELETING' },
			data: { status: 'DELETED' },
		});
		expect(orphanUpsert).toHaveBeenCalledWith(expect.objectContaining({
			where: { orphan_bucket_storage_key: { bucket: 'protected', storageKey: original.objectKey } },
			create: expect.objectContaining({ bucket: 'protected', storageKey: original.objectKey }),
		}));
	});

	it('rejects a representation CAS race before a terminal status or cleanup task is written', async () => {
		const tx = {
			$queryRaw: vi.fn()
				.mockResolvedValueOnce([{ id: 7 }])
				.mockResolvedValueOnce([{ id: 42, projectId: 7, kind: 'IMAGE', status: 'DELETING' }])
				.mockResolvedValueOnce([{ ...original, updatedAt: new Date(2) }]),
			asset: { updateMany: vi.fn() },
			orphanObject: { upsert: vi.fn() },
		};
		const repository = createAssetsRepository({
			$transaction: vi.fn(async (operation) => operation(tx)),
		} as unknown as PrismaClient);

		await expect(repository.completeAssetDeletion({
			id: 42, projectId: 7, kind: 'IMAGE', previousStatus: 'READY',
			representations: [original], alreadyDeleted: false,
		}, { reason: 'asset-delete' })).rejects.toMatchObject({ statusCode: 409 });
		expect(tx.asset.updateMany).not.toHaveBeenCalled();
		expect(tx.orphanObject.upsert).not.toHaveBeenCalled();
	});
});
