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
				}])
				.mockResolvedValueOnce([{
					id: 'rep-original', role: 'ORIGINAL', bucket: 'public-v2',
					objectKey: 'public/assets/42/original/g1.webp', updatedAt: new Date(1), checksum: 'sha256',
				}]),
		};
		const repository = createAssetsRepository({
			$transaction: vi.fn(async (operation) => operation(tx)),
		} as unknown as PrismaClient);

		await expect(repository.claimAssetForDeletion(42)).resolves.toMatchObject({
			id: 42,
			previousStatus: 'READY',
			storageKey: 'poster/current.png',
			representations: [expect.objectContaining({
				id: 'rep-original', bucket: 'public-v2', objectKey: 'public/assets/42/original/g1.webp',
			})],
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
		const sessionUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
		const orphanUpsert = vi.fn().mockResolvedValue({});
		const tx = {
			$queryRaw: vi.fn()
				.mockResolvedValueOnce([{ id: 7 }])
				.mockResolvedValueOnce([{
					id: 42,
					projectId: 7,
					kind: 'POSTER',
					status: 'DELETING',
					storageKey: 'poster/current.png',
					playbackStorageKey: null,
				}])
				.mockResolvedValueOnce([]),
			asset: { updateMany },
			gameUploadSession: { updateMany: sessionUpdateMany },
			orphanObject: {
				upsert: orphanUpsert,
				updateMany: vi.fn().mockResolvedValue({ count: 0 }),
			},
		};
		const repository = createAssetsRepository({
			$transaction: vi.fn(async (operation) => operation(tx)),
		} as unknown as PrismaClient);
		const claim = {
			id: 42,
			projectId: 7,
			kind: 'POSTER' as const,
			previousStatus: 'READY' as const,
			storageKey: 'poster/current.png',
			playbackStorageKey: null,
			representations: [],
			alreadyDeleted: false,
		};

		await repository.completeAssetDeletion(claim, {
			bucket: 'public',
			reason: 'asset-delete',
			playbackReason: 'asset-delete-playback',
		});

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
		expect(sessionUpdateMany).toHaveBeenCalledWith({
			where: {
				projectId: 7,
				status: 'COMPLETED',
				storageKey: 'poster/current.png',
			},
			data: { storageKey: null },
		});
		expect(orphanUpsert).toHaveBeenCalledWith(expect.objectContaining({
			where: {
				orphan_bucket_storage_key: {
					bucket: 'public',
					storageKey: 'poster/current.png',
				},
			},
			create: expect.objectContaining({
				bucket: 'public',
				storageKey: 'poster/current.png',
				reason: 'asset-delete',
			}),
		}));
	});

	it('queues canonical public/protected representations and deduplicates a legacy locator in the terminal transaction', async () => {
		const updatedAt = new Date(10);
		const orphanUpsert = vi.fn().mockResolvedValue({});
		const tx = {
			$queryRaw: vi.fn()
				.mockResolvedValueOnce([{ id: 7 }])
				.mockResolvedValueOnce([{
					id: 42, projectId: 7, kind: 'GAME', status: 'DELETING',
					storageKey: 'same.zip', playbackStorageKey: null,
				}])
				.mockResolvedValueOnce([
					{ id: 'original', role: 'ORIGINAL', bucket: 'protected', objectKey: 'same.zip', updatedAt, checksum: 'one' },
					{ id: 'preview', role: 'CARD_480', bucket: 'public', objectKey: 'public/assets/42/card/g1.webp', updatedAt, checksum: 'two' },
				]),
			asset: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
			gameUploadSession: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
			orphanObject: { upsert: orphanUpsert },
		};
		const repository = createAssetsRepository({
			$transaction: vi.fn(async (operation) => operation(tx)),
		} as unknown as PrismaClient);
		await repository.completeAssetDeletion({
			id: 42, projectId: 7, kind: 'GAME', previousStatus: 'READY',
			storageKey: 'same.zip', playbackStorageKey: null, alreadyDeleted: false,
			representations: [
				{ id: 'original', role: 'ORIGINAL', bucket: 'protected', objectKey: 'same.zip', updatedAt, checksum: 'one' },
				{ id: 'preview', role: 'CARD_480', bucket: 'public', objectKey: 'public/assets/42/card/g1.webp', updatedAt, checksum: 'two' },
			],
		}, { bucket: 'protected', reason: 'asset-delete', playbackReason: 'asset-delete-playback' });

		expect(orphanUpsert).toHaveBeenCalledTimes(2);
		expect(orphanUpsert).toHaveBeenCalledWith(expect.objectContaining({
			create: expect.objectContaining({ bucket: 'public', storageKey: 'public/assets/42/card/g1.webp' }),
		}));
	});

	it('rejects a representation CAS race before terminal status or outbox writes', async () => {
		const claimedAt = new Date(10);
		const tx = {
			$queryRaw: vi.fn()
				.mockResolvedValueOnce([{ id: 7 }])
				.mockResolvedValueOnce([{
					id: 42, projectId: 7, kind: 'IMAGE', status: 'DELETING', storageKey: null, playbackStorageKey: null,
				}])
				.mockResolvedValueOnce([{
					id: 'original', role: 'ORIGINAL', bucket: 'public', objectKey: 'public/assets/42/g2.webp',
					updatedAt: new Date(11), checksum: 'new',
				}]),
			asset: { updateMany: vi.fn() },
			gameUploadSession: { updateMany: vi.fn() },
			orphanObject: { upsert: vi.fn() },
		};
		const repository = createAssetsRepository({
			$transaction: vi.fn(async (operation) => operation(tx)),
		} as unknown as PrismaClient);
		await expect(repository.completeAssetDeletion({
			id: 42, projectId: 7, kind: 'IMAGE', previousStatus: 'READY', storageKey: null,
			playbackStorageKey: null, alreadyDeleted: false,
			representations: [{
				id: 'original', role: 'ORIGINAL', bucket: 'public', objectKey: 'public/assets/42/g1.webp',
				updatedAt: claimedAt, checksum: 'old',
			}],
		}, { bucket: 'public', reason: 'asset-delete', playbackReason: 'asset-delete-playback' }))
			.rejects.toMatchObject({ statusCode: 409 });
		expect(tx.asset.updateMany).not.toHaveBeenCalled();
		expect(tx.orphanObject.upsert).not.toHaveBeenCalled();
	});
});
