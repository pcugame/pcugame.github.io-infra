import { describe, expect, it, vi } from 'vitest';
import { createObjectDeletionCoordinator } from '../application/object-deletion.js';
import { deleteAsset } from '../modules/assets/service.js';

function assetDeletionHarness() {
	const repository = {
		findAllBannedIps: vi.fn(),
		findPublicAsset: vi.fn(),
		findAssetByStorageKey: vi.fn(),
		upsertBannedIp: vi.fn(),
		findAssetByIdWithProject: vi.fn().mockResolvedValue({
			id: 41,
			projectId: 7,
			kind: 'GAME' as const,
			storageKey: 'games/current.zip',
			playbackStorageKey: 'games/current-playback.mp4',
			project: { posterAssetId: 41 },
		}),
		markAssetDeleting: vi.fn().mockResolvedValue(undefined),
		clearPosterIfMatches: vi.fn().mockResolvedValue(undefined),
		markAssetDeleted: vi.fn().mockResolvedValue(undefined),
	};
	const deleteOrQueue = vi.fn().mockResolvedValue(undefined);
	const deps = {
		publicBucket: 'public',
		protectedBucket: 'protected',
		presign: vi.fn(),
		bucketForKind: () => 'protected',
		deleteOrQueue,
		loadProjectWithAccess: vi.fn().mockResolvedValue(undefined),
		downloadLimiter: {
			loadBannedIps: vi.fn(),
			check: vi.fn().mockReturnValue('ok' as const),
		},
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		repository,
	};
	return { deps, repository, deleteOrQueue };
}

describe('durable object deletion callers', () => {
	it('lets the caller finish after storage deletion without touching the queue', async () => {
		const { deps, repository } = assetDeletionHarness();
		repository.findAssetByIdWithProject.mockResolvedValueOnce({
			id: 41,
			projectId: 7,
			kind: 'GAME',
			storageKey: 'games/current.zip',
			playbackStorageKey: null,
			project: { posterAssetId: null },
		});
		const record = vi.fn().mockRejectedValue(new Error('queue must not be used'));
		const coordinator = createObjectDeletionCoordinator({
			storage: { delete: vi.fn().mockResolvedValue(undefined), listKeys: vi.fn() },
			orphans: { record },
			logger: { error: vi.fn() },
		});

		await expect(deleteAsset(
			{ ...deps, deleteOrQueue: coordinator.deleteOrQueue },
			41,
			{ id: 1, role: 'ADMIN' },
		)).resolves.toEqual({ projectId: 7 });
		expect(record).not.toHaveBeenCalled();
		expect(repository.markAssetDeleted).toHaveBeenCalledWith(41);
	});

	it('lets the caller finish with a durable orphan after storage deletion fails', async () => {
		const { deps, repository } = assetDeletionHarness();
		repository.findAssetByIdWithProject.mockResolvedValueOnce({
			id: 41,
			projectId: 7,
			kind: 'GAME',
			storageKey: 'games/current.zip',
			playbackStorageKey: null,
			project: { posterAssetId: null },
		});
		const record = vi.fn().mockResolvedValue(undefined);
		const coordinator = createObjectDeletionCoordinator({
			storage: {
				delete: vi.fn().mockRejectedValue(new Error('storage unavailable')),
				listKeys: vi.fn(),
			},
			orphans: { record },
			logger: { error: vi.fn() },
		});

		await expect(deleteAsset(
			{ ...deps, deleteOrQueue: coordinator.deleteOrQueue },
			41,
			{ id: 1, role: 'ADMIN' },
		)).resolves.toEqual({ projectId: 7 });
		expect(record).toHaveBeenCalledWith('protected', 'games/current.zip', 'asset-delete');
		expect(repository.markAssetDeleted).toHaveBeenCalledWith(41);
	});

	it('marks an asset deleted only after every object is deleted or durably queued', async () => {
		const { deps, repository, deleteOrQueue } = assetDeletionHarness();

		await expect(deleteAsset(deps, 41, { id: 1, role: 'ADMIN' }))
			.resolves.toEqual({ projectId: 7 });
		expect(deleteOrQueue).toHaveBeenCalledTimes(2);
		expect(repository.markAssetDeleting.mock.invocationCallOrder[0])
			.toBeLessThan(deleteOrQueue.mock.invocationCallOrder[0]!);
		expect(deleteOrQueue.mock.invocationCallOrder[1])
			.toBeLessThan(repository.markAssetDeleted.mock.invocationCallOrder[0]!);
	});

	it('leaves an asset non-terminal when storage deletion and orphan queueing both fail', async () => {
		const { deps, repository, deleteOrQueue } = assetDeletionHarness();
		deleteOrQueue.mockRejectedValueOnce(new Error('storage and orphan queue unavailable'));

		await expect(deleteAsset(deps, 41, { id: 1, role: 'ADMIN' }))
			.rejects.toThrow('storage and orphan queue unavailable');
		expect(repository.markAssetDeleting).toHaveBeenCalledWith(41);
		expect(repository.clearPosterIfMatches).not.toHaveBeenCalled();
		expect(repository.markAssetDeleted).not.toHaveBeenCalled();
	});
});
