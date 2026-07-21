import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCompletedUploadFinalizer } from '../modules/admin/game-upload/finalize-completed-upload.service.js';
import type { WebglDeploymentKeys } from '../modules/webgl/paths.js';

const deployment: WebglDeploymentKeys = {
	projectId: 7,
	deploymentId: '123e4567-e89b-42d3-a456-426614174000',
	deploymentPrefix: 'webgl/7/123e4567-e89b-42d3-a456-426614174000/',
	sourceKey: 'webgl/7/123e4567-e89b-42d3-a456-426614174000/source.zip',
	sitePrefix: 'webgl/7/123e4567-e89b-42d3-a456-426614174000/site/',
	entryKey: 'webgl/7/123e4567-e89b-42d3-a456-426614174000/site/index.html',
};

const webglSession = {
	id: 'upload-1',
	projectId: 7,
	uploadKind: 'WEBGL' as const,
	originalName: 'build.zip',
	totalBytes: 8n,
	s3Key: deployment.sourceKey,
};

function createDependencies() {
	return {
		readHeader: vi.fn().mockResolvedValue(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])),
		validateGameArchive: vi.fn().mockResolvedValue(undefined),
		deployWebgl: vi.fn().mockResolvedValue(deployment),
		cleanupWebglDeployment: vi.fn().mockResolvedValue(undefined),
		cleanupWebglEntry: vi.fn().mockResolvedValue(undefined),
		finalizeGame: vi.fn().mockResolvedValue({ oldStorageKey: null, oldPlaybackStorageKey: null }),
		finalizeWebgl: vi.fn().mockResolvedValue({ oldEntryKey: '' }),
		deleteOrQueue: vi.fn().mockResolvedValue(undefined),
		webglUrl: vi.fn().mockReturnValue('https://api.example.com/api/public/webgl/7/'),
		logError: vi.fn(),
	};
}

describe('completed upload finalizer', () => {
	beforeEach(() => vi.clearAllMocks());

	it('rejects a size mismatch before reading or deploying the object', async () => {
		const deps = createDependencies();
		const finalizer = createCompletedUploadFinalizer(deps);

		await expect(finalizer.finalize(webglSession, { size: 7 })).rejects.toMatchObject({
			code: 'SIZE_MISMATCH',
			statusCode: 500,
		});
		expect(deps.readHeader).not.toHaveBeenCalled();
		expect(deps.deployWebgl).not.toHaveBeenCalled();
	});

	it('removes a newly deployed WebGL tree when the DB pointer swap fails', async () => {
		const deps = createDependencies();
		deps.finalizeWebgl.mockRejectedValueOnce(new Error('database unavailable'));
		const finalizer = createCompletedUploadFinalizer(deps);

		await expect(finalizer.finalize(webglSession, { size: 8 }))
			.rejects.toThrow('database unavailable');
		expect(deps.cleanupWebglDeployment).toHaveBeenCalledWith(
			deployment,
			'webgl-upload-finalization-failed',
		);
	});

	it('keeps completion successful when cleanup of the previous deployment is queued', async () => {
		const deps = createDependencies();
		const oldEntryKey = 'webgl/7/old/site/index.html';
		deps.finalizeWebgl.mockResolvedValueOnce({ oldEntryKey });
		deps.cleanupWebglEntry.mockRejectedValueOnce(new Error('queue unavailable'));
		const finalizer = createCompletedUploadFinalizer(deps);

		await expect(finalizer.finalize(webglSession, { size: 8 })).resolves.toEqual({
			status: 'COMPLETED',
			storageKey: deployment.sourceKey,
			sizeBytes: 8,
			webglUrl: 'https://api.example.com/api/public/webgl/7/',
		});
		expect(deps.logError).toHaveBeenCalledOnce();
		expect(deps.cleanupWebglDeployment).not.toHaveBeenCalled();
	});
});
