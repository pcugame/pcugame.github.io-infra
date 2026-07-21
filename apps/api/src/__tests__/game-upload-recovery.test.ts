import { describe, expect, it, vi } from 'vitest';
import type {
	GameUploadServiceDependencies,
	GameUploadSessionSummary,
} from '../modules/admin/game-upload/ports.js';
import { sweepStaleCompletingSessions } from '../modules/admin/game-upload/session-maintenance.service.js';
import { badRequest } from '../shared/errors.js';

function staleSession(
	overrides: Partial<GameUploadSessionSummary> = {},
): GameUploadSessionSummary {
	return {
		id: 'stale-upload',
		projectId: 7,
		userId: 11,
		uploadKind: 'WEBGL',
		originalName: 'build.zip',
		totalBytes: 8n,
		chunkSizeBytes: 8,
		totalChunks: 1,
		uploadedChunks: [0],
		status: 'COMPLETING',
		expiresAt: new Date('2026-07-21T01:00:00.000Z'),
		s3UploadId: 'multipart-1',
		s3Key: 'webgl/7/deployment/source.zip',
		...overrides,
	};
}

function createHarness(session = staleSession()) {
	const mocks = {
		findStale: vi.fn().mockResolvedValue([session]),
		head: vi.fn().mockResolvedValue({ size: 8, contentType: 'application/zip' }),
		finalize: vi.fn().mockResolvedValue({
			status: 'COMPLETED' as const,
			storageKey: session.s3Key ?? '',
			sizeBytes: 8,
		}),
		markFailed: vi.fn().mockResolvedValue({ count: 1 }),
		abortMultipart: vi.fn().mockResolvedValue(undefined),
		deleteOrQueue: vi.fn().mockResolvedValue(undefined),
		logError: vi.fn(),
		logWarn: vi.fn(),
	};
	const deps: GameUploadServiceDependencies = {
		repository: {
			findSessionById: vi.fn(),
			createSessionReplacingActive: vi.fn(),
			cancelSessionAndClearActive: vi.fn(),
			upsertPartEtag: vi.fn(),
			transitionToCompleting: vi.fn(),
			findPartsBySessionId: vi.fn(),
			revertToPending: vi.fn(),
			markFailed: mocks.markFailed,
			findStaleCompletingSessions: mocks.findStale,
			findActiveSessionsForListing: vi.fn(),
			findExhibitionById: vi.fn(),
		},
		storage: {
			createMultipart: vi.fn(),
			abortMultipart: mocks.abortMultipart,
			uploadPart: vi.fn(),
			completeMultipart: vi.fn(),
			head: mocks.head,
		},
		finalizer: { finalize: mocks.finalize },
		settings: { get: vi.fn() },
		uploadSlots: { acquire: vi.fn(), release: vi.fn() },
		clock: { now: () => new Date('2026-07-21T00:10:00.000Z') },
		ids: { next: () => 'id' },
		lifecycle: { isAcceptingNewWork: () => true },
		config: { uploadChunkSizeMb: 10, uploadSessionTtlMinutes: 60 },
		roleGameMaxBytes: () => 1024,
		storageKey: () => 'key',
		deleteOrQueue: mocks.deleteOrQueue,
		logger: { error: mocks.logError, warn: mocks.logWarn },
	};
	return { deps, mocks };
}

describe('stale upload recovery', () => {
	it('uses the normal finalizer when the completed source object exists', async () => {
		const session = staleSession();
		const { deps, mocks } = createHarness(session);

		await expect(sweepStaleCompletingSessions(deps)).resolves.toEqual({ swept: 1 });

		expect(mocks.findStale).toHaveBeenCalledWith(new Date('2026-07-21T00:05:00.000Z'));
		expect(mocks.finalize).toHaveBeenCalledWith({
			id: session.id,
			projectId: session.projectId,
			uploadKind: session.uploadKind,
			originalName: session.originalName,
			totalBytes: session.totalBytes,
			s3Key: session.s3Key,
		}, { size: 8, contentType: 'application/zip' });
		expect(mocks.markFailed).not.toHaveBeenCalled();
		expect(mocks.deleteOrQueue).not.toHaveBeenCalled();
	});

	it('preserves the session and object after a transient recovery failure', async () => {
		const { deps, mocks } = createHarness();
		mocks.finalize.mockRejectedValueOnce(new Error('database unavailable'));

		await expect(sweepStaleCompletingSessions(deps)).resolves.toEqual({ swept: 1 });

		expect(mocks.markFailed).not.toHaveBeenCalled();
		expect(mocks.deleteOrQueue).not.toHaveBeenCalled();
		expect(mocks.logError).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: 'stale-upload' }),
			'Boot sweep: transient finalization failure; leaving session recoverable',
		);
	});

	it('does not destroy upload state when object storage cannot be inspected', async () => {
		const { deps, mocks } = createHarness();
		mocks.head.mockRejectedValueOnce(new Error('storage unavailable'));

		await expect(sweepStaleCompletingSessions(deps)).resolves.toEqual({ swept: 1 });

		expect(mocks.finalize).not.toHaveBeenCalled();
		expect(mocks.abortMultipart).not.toHaveBeenCalled();
		expect(mocks.markFailed).not.toHaveBeenCalled();
	});

	it('fails and deletes only a deterministically invalid completed object', async () => {
		const { deps, mocks } = createHarness();
		mocks.finalize.mockRejectedValueOnce(badRequest('Unsafe ZIP path'));

		await expect(sweepStaleCompletingSessions(deps)).resolves.toEqual({ swept: 1 });

		expect(mocks.markFailed).toHaveBeenCalledWith(
			'stale-upload',
			'webgl/7/deployment/source.zip',
		);
		expect(mocks.deleteOrQueue).toHaveBeenCalledWith(
			'webgl/7/deployment/source.zip',
			'webgl-upload-sweep-invalid',
			{ sessionId: 'stale-upload' },
		);
	});

	it('aborts an unfinished multipart upload only after a successful not-found check', async () => {
		const { deps, mocks } = createHarness();
		mocks.head.mockResolvedValueOnce(null);

		await expect(sweepStaleCompletingSessions(deps)).resolves.toEqual({ swept: 1 });

		expect(mocks.abortMultipart).toHaveBeenCalledWith(
			'webgl/7/deployment/source.zip',
			'multipart-1',
		);
		expect(mocks.markFailed).toHaveBeenCalledWith('stale-upload');
	});
});
