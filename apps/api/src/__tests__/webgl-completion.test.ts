import { beforeEach, describe, expect, it, vi } from 'vitest';
import { completeSession } from '../modules/admin/game-upload/complete-session.service.js';
import { cancelSession } from '../modules/admin/game-upload/session-maintenance.service.js';
import { createCompletedUploadFinalizer } from '../modules/admin/game-upload/finalize-completed-upload.service.js';
import type { GameUploadServiceDependencies } from '../modules/admin/game-upload/ports.js';
import type { WebglDeploymentKeys } from '../modules/webgl/paths.js';

const sourceKey = 'webgl/7/123e4567-e89b-42d3-a456-426614174000/source.zip';
const deployed: WebglDeploymentKeys = {
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
		uploadKind: 'WEBGL' as const,
		originalName: 'webgl.zip',
		totalBytes: 8n,
		chunkSizeBytes: 8,
		totalChunks: 1,
		uploadedChunks: [],
		status: 'PENDING',
		expiresAt: new Date('2026-07-22T00:00:00.000Z'),
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

function createHarness() {
	const mocks = {
		findSessionById: vi.fn().mockResolvedValue(session()),
		transitionToCompleting: vi.fn().mockResolvedValue({ count: 1 }),
		findPartsBySessionId: vi.fn().mockResolvedValue([{ partNumber: 1, etag: 'etag' }]),
		finalizeCompletedWebglSession: vi.fn().mockResolvedValue({ oldEntryKey: '' }),
		markFailed: vi.fn().mockResolvedValue({ count: 1 }),
		revertToPending: vi.fn().mockResolvedValue({ count: 1 }),
		completeMultipart: vi.fn().mockResolvedValue(undefined),
		head: vi.fn().mockResolvedValue({ size: 8, contentType: 'application/zip' }),
		readHeader: vi.fn().mockResolvedValue(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])),
		deleteOrQueue: vi.fn().mockResolvedValue(undefined),
		deployWebgl: vi.fn().mockResolvedValue(deployed),
		cleanupWebglDeployment: vi.fn().mockResolvedValue(undefined),
		cleanupWebglEntry: vi.fn().mockResolvedValue(undefined),
		logError: vi.fn(),
	};
	const finalizer = createCompletedUploadFinalizer({
		readHeader: mocks.readHeader,
		validateGameArchive: vi.fn(),
		deployWebgl: mocks.deployWebgl,
		cleanupWebglDeployment: mocks.cleanupWebglDeployment,
		cleanupWebglEntry: mocks.cleanupWebglEntry,
		finalizeGame: vi.fn().mockResolvedValue({ oldStorageKey: null, oldPlaybackStorageKey: null }),
		finalizeWebgl: mocks.finalizeCompletedWebglSession,
		deleteOrQueue: mocks.deleteOrQueue,
		webglUrl: () => 'http://localhost:4000/api/public/webgl/7/',
		logError: mocks.logError,
	});
	const deps: GameUploadServiceDependencies = {
		repository: {
			findSessionById: mocks.findSessionById,
			createSessionReplacingActive: vi.fn(),
			cancelSessionAndClearActive: vi.fn(),
			upsertPartEtag: vi.fn(),
			transitionToCompleting: mocks.transitionToCompleting,
			findPartsBySessionId: mocks.findPartsBySessionId,
			revertToPending: mocks.revertToPending,
			markFailed: mocks.markFailed,
			findStaleCompletingSessions: vi.fn(),
			findActiveSessionsForListing: vi.fn(),
			findExhibitionById: vi.fn(),
		},
		storage: {
			createMultipart: vi.fn(),
			abortMultipart: vi.fn(),
			uploadPart: vi.fn(),
			completeMultipart: mocks.completeMultipart,
			head: mocks.head,
		},
		finalizer,
		settings: { get: vi.fn() },
		uploadSlots: { acquire: vi.fn(), release: vi.fn() },
		clock: { now: () => new Date('2026-07-21T00:00:00.000Z') },
		ids: { next: () => 'id' },
		lifecycle: { isAcceptingNewWork: () => true },
		config: { uploadChunkSizeMb: 10, uploadSessionTtlMinutes: 60 },
		roleGameMaxBytes: () => 1024,
		storageKey: () => sourceKey,
		deleteOrQueue: mocks.deleteOrQueue,
		logger: { error: mocks.logError, warn: vi.fn() },
	};
	return {
		mocks,
		deps,
		complete: () => completeSession(deps, 'session-webgl', { id: 11, role: 'USER' }),
	};
}

describe('WebGL completion atomicity', () => {
	beforeEach(() => vi.clearAllMocks());

	it('does not swap the DB pointer before every hosted file is deployed', async () => {
		const { mocks, complete } = createHarness();
		const gate = deferred<WebglDeploymentKeys>();
		mocks.deployWebgl.mockReturnValue(gate.promise);

		const completion = complete();
		await vi.waitFor(() => expect(mocks.deployWebgl).toHaveBeenCalled());
		expect(mocks.finalizeCompletedWebglSession).not.toHaveBeenCalled();

		gate.resolve(deployed);
		await expect(completion).resolves.toMatchObject({
			status: 'COMPLETED',
			storageKey: sourceKey,
			webglUrl: 'http://localhost:4000/api/public/webgl/7/',
		});
		expect(mocks.finalizeCompletedWebglSession).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'session-webgl', projectId: 7 }),
			deployed,
		);
	});

	it('rejects a duplicate completion before calling multipart completion', async () => {
		const { mocks, complete } = createHarness();
		mocks.transitionToCompleting.mockResolvedValue({ count: 0 });

		await expect(complete()).rejects.toMatchObject({
			statusCode: 400,
			message: 'Session is already being completed by another request',
		});
		expect(mocks.completeMultipart).not.toHaveBeenCalled();
	});

	it('preserves COMPLETING when multipart outcome cannot be inspected', async () => {
		const { mocks, complete } = createHarness();
		mocks.completeMultipart.mockRejectedValueOnce(new Error('completion response lost'));
		mocks.head.mockRejectedValueOnce(new Error('storage unavailable'));

		await expect(complete()).rejects.toThrow('completion response lost');
		expect(mocks.revertToPending).not.toHaveBeenCalled();
		expect(mocks.markFailed).not.toHaveBeenCalled();
		expect(mocks.deleteOrQueue).not.toHaveBeenCalled();
		expect(mocks.logError).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: 'session-webgl', storageKey: sourceKey }),
			'Could not determine whether multipart completion created the final object; preserving COMPLETING state',
		);
	});

	it('does not abort storage when cancellation loses the state compare-and-set', async () => {
		const { mocks, deps } = createHarness();
		deps.repository.cancelSessionAndClearActive = vi.fn().mockResolvedValue({ count: 0 });

		await expect(cancelSession(deps, 'session-webgl', { id: 11, role: 'USER' }))
			.rejects.toThrow('Session state changed');
		expect(deps.storage.abortMultipart).not.toHaveBeenCalled();
		expect(mocks.completeMultipart).not.toHaveBeenCalled();
	});

	it('preserves a completed source for restart recovery when deployment fails transiently', async () => {
		const { mocks, complete } = createHarness();
		mocks.deployWebgl.mockRejectedValue(new Error('public upload failed'));

		await expect(complete()).rejects.toThrow('public upload failed');
		expect(mocks.finalizeCompletedWebglSession).not.toHaveBeenCalled();
		expect(mocks.markFailed).not.toHaveBeenCalled();
		expect(mocks.deleteOrQueue).not.toHaveBeenCalled();
		expect(mocks.logError).not.toHaveBeenCalled();
	});

	it('marks a deterministically invalid completed source failed and queues deletion', async () => {
		const { mocks, complete } = createHarness();
		mocks.readHeader.mockResolvedValue(Buffer.from('not-a-zip'));

		await expect(complete()).rejects.toMatchObject({ statusCode: 400 });
		expect(mocks.markFailed).toHaveBeenCalledWith('session-webgl', sourceKey);
		expect(mocks.deleteOrQueue).toHaveBeenCalledWith(
			sourceKey,
			'webgl-upload-completion-invalid',
			{ sessionId: 'session-webgl' },
		);
	});

	it('cleans the previous deployment after the pointer swap', async () => {
		const { mocks, complete } = createHarness();
		const oldEntry = 'webgl/7/123e4567-e89b-42d3-b456-426614174111/site/index.html';
		mocks.finalizeCompletedWebglSession.mockResolvedValue({ oldEntryKey: oldEntry });

		await complete();
		expect(mocks.cleanupWebglEntry).toHaveBeenCalledWith(
			7,
			oldEntry,
			'webgl-upload-replace-previous',
		);
	});

	it('keeps the new deployment completed when old-deployment cleanup fails', async () => {
		const { mocks, complete } = createHarness();
		mocks.finalizeCompletedWebglSession.mockResolvedValue({
			oldEntryKey: 'webgl/7/123e4567-e89b-42d3-b456-426614174111/site/index.html',
		});
		mocks.cleanupWebglEntry.mockRejectedValue(new Error('orphan queue unavailable'));

		await expect(complete()).resolves.toMatchObject({ status: 'COMPLETED' });
		expect(mocks.markFailed).not.toHaveBeenCalled();
		expect(mocks.cleanupWebglDeployment).not.toHaveBeenCalled();
		expect(mocks.logError).toHaveBeenCalledOnce();
	});
});
