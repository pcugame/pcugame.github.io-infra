import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectService } from '../modules/admin/project/service.js';

const mocks = {
	clearWebglDeployment: vi.fn(),
	deleteProjectReturningAssets: vi.fn(),
	bulkDeleteProjectsReturningAssets: vi.fn(),
	abortMultipart: vi.fn(),
	wakeDeletionWorker: vi.fn(),
	wakeMaintenance: vi.fn(),
};

const projectService = createProjectService({
	deletionBuckets: { publicBucket: 'public', protectedBucket: 'protected' },
	repository: {
		clearWebglDeployment: mocks.clearWebglDeployment,
		deleteProjectReturningAssets: mocks.deleteProjectReturningAssets,
		bulkDeleteProjectsReturningAssets: mocks.bulkDeleteProjectsReturningAssets,
		findProjectsForUser: vi.fn(),
		findProjectById: vi.fn(),
		isMemberOfProject: vi.fn(),
		updateProject: vi.fn(),
		findAssetById: vi.fn(),
		setProjectPoster: vi.fn(),
	},
	serializeProjectDetail: vi.fn(),
	abortMultipart: mocks.abortMultipart,
	wakeDeletionWorker: mocks.wakeDeletionWorker,
	wakeMaintenance: mocks.wakeMaintenance,
	logger: { error: vi.fn() },
});

const oldEntry = 'webgl/7/123e4567-e89b-42d3-a456-426614174000/site/index.html';
const activeSource = 'webgl/7/123e4567-e89b-42d3-b456-426614174111/source.zip';

const activeWebgl = {
	id: 'webgl-session',
	projectId: 7,
	uploadKind: 'WEBGL',
	s3Key: activeSource,
	s3UploadId: 'webgl-multipart',
};

describe('WebGL deletion cleanup', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.abortMultipart.mockResolvedValue(undefined);
	});

	it('commits WebGL deletion targets, wakes workers, and best-effort aborts the tracked upload', async () => {
		mocks.clearWebglDeployment.mockResolvedValue({
			oldEntryKey: oldEntry,
			cancelledSession: activeWebgl,
		});

		await projectService.deleteWebgl(7);

		expect(mocks.clearWebglDeployment).toHaveBeenCalledWith(7, {
			publicBucket: 'public',
			protectedBucket: 'protected',
			reason: 'webgl-delete',
		});
		expect(mocks.abortMultipart).toHaveBeenCalledWith(activeSource, 'webgl-multipart');
		expect(mocks.wakeDeletionWorker).toHaveBeenCalledOnce();
		expect(mocks.wakeMaintenance).toHaveBeenCalledOnce();
	});

	it('uses one worker wake for all project asset and WebGL outbox targets', async () => {
		const gameUpload = {
			id: 'game-session',
			projectId: 7,
			uploadKind: 'GAME',
			s3Key: 'uploads/game.zip',
			s3UploadId: 'game-multipart',
		};
		mocks.deleteProjectReturningAssets.mockResolvedValue({
			assets: [{ id: 5, storageKey: 'poster.webp' }],
			webglEntryKey: oldEntry,
			activeUploads: [gameUpload, activeWebgl],
		});

		await projectService.deleteProject(7);

		expect(mocks.deleteProjectReturningAssets).toHaveBeenCalledWith(7, {
			publicBucket: 'public',
			protectedBucket: 'protected',
			reason: 'project-delete',
		});
		expect(mocks.abortMultipart).toHaveBeenCalledTimes(2);
		expect(mocks.wakeDeletionWorker).toHaveBeenCalledOnce();
		expect(mocks.wakeMaintenance).toHaveBeenCalledOnce();
	});

	it('includes WebGL builds in bulk deletion cleanup and result counts', async () => {
		mocks.bulkDeleteProjectsReturningAssets.mockResolvedValue({
			result: { count: 2 },
			assets: [],
			projects: [
				{ id: 7, webglEntryKey: oldEntry },
				{ id: 8, webglEntryKey: '' },
			],
			activeUploads: [activeWebgl],
		});

		await expect(projectService.bulkDeleteProjects([7, 8])).resolves.toEqual({
			deleted: 2,
			assetsRemoved: 0,
			webglBuildsRemoved: 1,
		});
		expect(mocks.bulkDeleteProjectsReturningAssets).toHaveBeenCalledWith([7, 8], {
			publicBucket: 'public',
			protectedBucket: 'protected',
			reason: 'project-bulk-delete',
		});
		expect(mocks.wakeDeletionWorker).toHaveBeenCalledOnce();
		expect(mocks.wakeMaintenance).toHaveBeenCalledOnce();
	});
});
