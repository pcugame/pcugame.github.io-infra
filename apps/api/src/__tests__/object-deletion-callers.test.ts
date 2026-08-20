import { describe, expect, it, vi } from 'vitest';
import { deleteAsset } from '../modules/assets/service.js';

function assetDeletionHarness() {
	const repository = {
		findAllBannedIps: vi.fn(),
		findAssetByStorageKey: vi.fn(),
		findAssetByIdForDownload: vi.fn(),
		findAssetByIdWithProject: vi.fn().mockResolvedValue({
			id: 41,
			projectId: 7,
			project: { posterAssetId: 41 },
		}),
		claimAssetForDeletion: vi.fn().mockResolvedValue({
			id: 41,
			projectId: 7,
			kind: 'GAME' as const,
			previousStatus: 'READY' as const,
			storageKey: 'games/current.zip',
			playbackStorageKey: 'games/current-playback.mp4',
			alreadyDeleted: false,
		}),
		completeAssetDeletion: vi.fn().mockResolvedValue(undefined),
	};
	const wakeDeletionWorker = vi.fn();
	const deps = {
		presign: vi.fn(),
		bucketForKind: () => 'protected',
		wakeDeletionWorker,
		loadProjectWithAccess: vi.fn().mockResolvedValue(undefined),
		downloadLimiter: {
			loadBannedIps: vi.fn(),
			check: vi.fn().mockReturnValue('ok' as const),
		},
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		repository,
	};
	return { deps, repository, wakeDeletionWorker };
}

describe('durable object deletion callers', () => {
	it('returns after the durable asset outbox commit and wakes one worker', async () => {
		const { deps, repository, wakeDeletionWorker } = assetDeletionHarness();
		repository.claimAssetForDeletion.mockResolvedValueOnce({
			id: 41, projectId: 7, kind: 'GAME', previousStatus: 'READY',
			storageKey: 'games/current.zip', playbackStorageKey: null, alreadyDeleted: false,
		});

		await expect(deleteAsset(deps, 41, { id: 1, role: 'ADMIN' }))
			.resolves.toEqual({ projectId: 7 });
		expect(repository.completeAssetDeletion).toHaveBeenCalledOnce();
		expect(wakeDeletionWorker).toHaveBeenCalledOnce();
	});

	it('coalesces original and playback deletion targets into one request-path wake', async () => {
		const { deps, repository, wakeDeletionWorker } = assetDeletionHarness();

		await expect(deleteAsset(deps, 41, { id: 1, role: 'ADMIN' }))
			.resolves.toEqual({ projectId: 7 });
		expect(repository.completeAssetDeletion).toHaveBeenCalledWith(
			expect.objectContaining({
				storageKey: 'games/current.zip',
				playbackStorageKey: 'games/current-playback.mp4',
			}),
			expect.objectContaining({
				reason: 'asset-delete',
				playbackReason: 'asset-delete-playback',
			}),
		);
		expect(wakeDeletionWorker).toHaveBeenCalledOnce();
	});

	it('commits the asset delete outbox before waking background deletion', async () => {
		const { deps, repository, wakeDeletionWorker } = assetDeletionHarness();

		await expect(deleteAsset(deps, 41, { id: 1, role: 'ADMIN' }))
			.resolves.toEqual({ projectId: 7 });
		expect(repository.claimAssetForDeletion.mock.invocationCallOrder[0])
			.toBeLessThan(repository.completeAssetDeletion.mock.invocationCallOrder[0]!);
		expect(repository.completeAssetDeletion.mock.invocationCallOrder[0])
			.toBeLessThan(wakeDeletionWorker.mock.invocationCallOrder[0]!);
	});

	it('does not report success when the transaction cannot commit its deletion outbox', async () => {
		const { deps, repository, wakeDeletionWorker } = assetDeletionHarness();
		repository.completeAssetDeletion.mockRejectedValueOnce(new Error('database unavailable'));

		await expect(deleteAsset(deps, 41, { id: 1, role: 'ADMIN' }))
			.rejects.toThrow('database unavailable');
		expect(repository.claimAssetForDeletion).toHaveBeenCalledWith(41);
		expect(repository.completeAssetDeletion).toHaveBeenCalledOnce();
		expect(wakeDeletionWorker).not.toHaveBeenCalled();
	});
});
