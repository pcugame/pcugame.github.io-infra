import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectService } from '../modules/admin/project/service.js';

const mocks = {
	clearWebglDeployment: vi.fn(),
	deleteProjectReturningAssets: vi.fn(),
	bulkDeleteProjectsReturningAssets: vi.fn(),
	deleteAssetObjects: vi.fn(),
	abortMultipart: vi.fn(),
	cleanupWebglEntry: vi.fn(),
	cleanupWebglDeployment: vi.fn(),
};

const projectService = createProjectService({
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
	deleteAssetObjects: mocks.deleteAssetObjects,
	abortMultipart: mocks.abortMultipart,
	cleanupWebglEntry: mocks.cleanupWebglEntry,
	cleanupWebglDeployment: mocks.cleanupWebglDeployment,
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
		mocks.cleanupWebglEntry.mockResolvedValue(undefined);
		mocks.cleanupWebglDeployment.mockResolvedValue(undefined);
		mocks.deleteAssetObjects.mockResolvedValue(undefined);
	});

	it('deletes only the WebGL pointer, source upload, and hosted deployment', async () => {
		mocks.clearWebglDeployment.mockResolvedValue({
			oldEntryKey: oldEntry,
			cancelledSession: activeWebgl,
		});

		await projectService.deleteWebgl(7);

		expect(mocks.cleanupWebglEntry).toHaveBeenCalledWith(7, oldEntry, 'webgl-delete');
		expect(mocks.abortMultipart).toHaveBeenCalledWith(activeSource, 'webgl-multipart');
		expect(mocks.cleanupWebglDeployment).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: 7,
				sourceKey: activeSource,
				entryKey: activeSource.replace('source.zip', 'site/index.html'),
			}),
			'webgl-delete-active-upload',
		);
	});

	it('cleans WebGL alongside a single project while preserving normal asset cleanup', async () => {
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

		expect(mocks.deleteAssetObjects).toHaveBeenCalledWith(
			expect.objectContaining({ id: 5, projectId: 7 }),
			'project-delete',
		);
		expect(mocks.abortMultipart).toHaveBeenCalledTimes(2);
		expect(mocks.cleanupWebglDeployment).toHaveBeenCalledTimes(1);
		expect(mocks.cleanupWebglEntry).toHaveBeenCalledWith(7, oldEntry, 'project-delete');
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
		expect(mocks.cleanupWebglEntry).toHaveBeenCalledWith(7, oldEntry, 'project-bulk-delete');
		expect(mocks.cleanupWebglDeployment).toHaveBeenCalledTimes(1);
	});
});
