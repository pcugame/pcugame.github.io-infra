import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultTestEnv } from './helpers/app-mocks.js';

const mocks = vi.hoisted(() => ({
	findSessionById: vi.fn(),
	transitionToCompleting: vi.fn(),
	findPartsBySessionId: vi.fn(),
	finalizeCompletedWebglSession: vi.fn(),
	markFailed: vi.fn(),
	revertToPending: vi.fn(),
	completeMultipartUpload: vi.fn(),
	headObject: vi.fn(),
	readObjectRange: vi.fn(),
	safeDeleteObject: vi.fn(),
	deployWebglSource: vi.fn(),
	cleanupWebglDeployment: vi.fn(),
	cleanupWebglEntry: vi.fn(),
}));

vi.mock('../config/env.js', () => ({
	env: () => ({ ...defaultTestEnv }),
	loadEnv: () => ({ ...defaultTestEnv }),
}));
vi.mock('../modules/admin/game-upload/repository.js', () => ({
	findSessionById: mocks.findSessionById,
	transitionToCompleting: mocks.transitionToCompleting,
	findPartsBySessionId: mocks.findPartsBySessionId,
	finalizeCompletedWebglSession: mocks.finalizeCompletedWebglSession,
	finalizeCompletedSession: vi.fn(),
	markFailed: mocks.markFailed,
	revertToPending: mocks.revertToPending,
}));
vi.mock('../lib/storage.js', () => ({
	completeMultipartUpload: mocks.completeMultipartUpload,
	headObject: mocks.headObject,
	readObjectRange: mocks.readObjectRange,
	safeDeleteObject: mocks.safeDeleteObject,
}));
vi.mock('../modules/webgl/deployment.js', () => ({
	deployWebglSource: mocks.deployWebglSource,
	cleanupWebglDeployment: mocks.cleanupWebglDeployment,
	cleanupWebglEntry: mocks.cleanupWebglEntry,
}));

import { completeSession } from '../modules/admin/game-upload/complete-session.service.js';

const sourceKey = 'webgl/7/123e4567-e89b-42d3-a456-426614174000/source.zip';
const deployed = {
	projectId: 7,
	deploymentId: '123e4567-e89b-42d3-a456-426614174000',
	deploymentPrefix: 'webgl/7/123e4567-e89b-42d3-a456-426614174000/',
	sourceKey,
	sitePrefix: 'webgl/7/123e4567-e89b-42d3-a456-426614174000/site/',
	entryKey: 'webgl/7/123e4567-e89b-42d3-a456-426614174000/site/index.html',
};

function session() {
	return {
		id: 'session-webgl',
		projectId: 7,
		userId: 11,
		uploadKind: 'WEBGL',
		originalName: 'webgl.zip',
		totalBytes: 8n,
		chunkSizeBytes: 8,
		totalChunks: 1,
		uploadedChunks: [],
		status: 'PENDING',
		expiresAt: new Date(Date.now() + 60_000),
		s3UploadId: 'multipart',
		s3Key: sourceKey,
		parts: [{ partNumber: 1, etag: 'etag' }],
		project: { status: 'PUBLISHED' },
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

describe('WebGL completion atomicity', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findSessionById.mockResolvedValue(session());
		mocks.transitionToCompleting.mockResolvedValue({ count: 1 });
		mocks.findPartsBySessionId.mockResolvedValue([{ partNumber: 1, etag: 'etag' }]);
		mocks.headObject.mockResolvedValue({ size: 8, contentType: 'application/zip' });
		mocks.readObjectRange.mockResolvedValue(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));
		mocks.completeMultipartUpload.mockResolvedValue(undefined);
		mocks.markFailed.mockResolvedValue({ count: 1 });
		mocks.cleanupWebglEntry.mockResolvedValue(undefined);
		mocks.cleanupWebglDeployment.mockResolvedValue(undefined);
	});

	it('does not swap the DB pointer before every hosted file is deployed', async () => {
		const gate = deferred<typeof deployed>();
		mocks.deployWebglSource.mockReturnValue(gate.promise);
		mocks.finalizeCompletedWebglSession.mockResolvedValue({ oldEntryKey: '' });

		const completion = completeSession('session-webgl', { id: 11, role: 'USER' });
		await vi.waitFor(() => expect(mocks.deployWebglSource).toHaveBeenCalled());
		expect(mocks.finalizeCompletedWebglSession).not.toHaveBeenCalled();

		gate.resolve(deployed);
		await expect(completion).resolves.toMatchObject({
			status: 'COMPLETED',
			storageKey: sourceKey,
			webglUrl: 'http://localhost:4000/api/public/webgl/7/',
		});
		expect(mocks.finalizeCompletedWebglSession).toHaveBeenCalledWith(
			'session-webgl',
			7,
			deployed.entryKey,
			sourceKey,
		);
	});

	it('keeps the previous pointer and cleans the new source when deployment fails', async () => {
		mocks.deployWebglSource.mockRejectedValue(new Error('public upload failed'));

		await expect(completeSession('session-webgl', { id: 11, role: 'USER' }))
			.rejects.toThrow('public upload failed');
		expect(mocks.finalizeCompletedWebglSession).not.toHaveBeenCalled();
		expect(mocks.markFailed).toHaveBeenCalledWith('session-webgl', sourceKey);
		expect(mocks.safeDeleteObject).toHaveBeenCalledWith(
			'pcu-protected',
			sourceKey,
			'webgl-upload-completion-failed',
			{ sessionId: 'session-webgl' },
		);
	});

	it('cleans both old source and hosted prefix after the pointer swap', async () => {
		mocks.deployWebglSource.mockResolvedValue(deployed);
		const oldEntry = 'webgl/7/123e4567-e89b-42d3-b456-426614174111/site/index.html';
		mocks.finalizeCompletedWebglSession.mockResolvedValue({ oldEntryKey: oldEntry });

		await completeSession('session-webgl', { id: 11, role: 'USER' });
		expect(mocks.cleanupWebglEntry).toHaveBeenCalledWith(
			7,
			oldEntry,
			'webgl-upload-replace-previous',
		);
	});

	it('keeps the new deployment completed when cleanup of the previous deployment fails', async () => {
		mocks.deployWebglSource.mockResolvedValue(deployed);
		mocks.finalizeCompletedWebglSession.mockResolvedValue({
			oldEntryKey: 'webgl/7/123e4567-e89b-42d3-b456-426614174111/site/index.html',
		});
		mocks.cleanupWebglEntry.mockRejectedValue(new Error('orphan queue unavailable'));

		await expect(completeSession('session-webgl', { id: 11, role: 'USER' }))
			.resolves.toMatchObject({ status: 'COMPLETED', webglUrl: expect.any(String) });
		expect(mocks.markFailed).not.toHaveBeenCalled();
		expect(mocks.cleanupWebglDeployment).not.toHaveBeenCalled();
	});
});
