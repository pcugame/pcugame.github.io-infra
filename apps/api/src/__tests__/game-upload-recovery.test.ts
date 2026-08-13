import { describe, expect, it, vi } from 'vitest';
import type {
	GameUploadServiceDependencies,
	GameUploadSessionSummary,
} from '../modules/admin/game-upload/ports.js';
import { sweepStaleCompletingSessions } from '../modules/admin/game-upload/session-maintenance.service.js';
import { badRequest } from '../shared/errors.js';
import { createDurableGameUploadRepository } from './helpers/upload-lifecycle.js';

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
		claimStale: vi.fn().mockResolvedValue([session]),
		head: vi.fn().mockResolvedValue({ size: 8, contentType: 'application/zip' }),
		finalize: vi.fn().mockResolvedValue({
			status: 'COMPLETED' as const,
			storageKey: session.s3Key ?? '',
			sizeBytes: 8,
		}),
		markFailed: vi.fn().mockResolvedValue({ count: 1 }),
		markCompletedObjectFailed: vi.fn().mockResolvedValue({ count: 1 }),
		revertToPending: vi.fn().mockResolvedValue({ count: 1 }),
		abortMultipart: vi.fn().mockResolvedValue(undefined),
		deleteOrQueue: vi.fn().mockResolvedValue(undefined),
		logError: vi.fn(),
		logWarn: vi.fn(),
	};
	const deps: GameUploadServiceDependencies = {
		repository: createDurableGameUploadRepository({
			findSessionById: vi.fn(),
			createSessionReplacingActive: vi.fn(),
			cancelSessionAndClearActive: vi.fn(),
			findPartsBySessionId: vi.fn(),
			revertToPending: mocks.revertToPending,
			markFailed: mocks.markFailed,
			markCompletedObjectFailed: mocks.markCompletedObjectFailed,
			claimStaleCompletingSessions: mocks.claimStale,
			findActiveSessionsForListing: vi.fn(),
			findExhibitionById: vi.fn(),
		}),
		storage: {
			createMultipart: vi.fn(),
			abortMultipart: mocks.abortMultipart,
			uploadPart: vi.fn(),
			completeMultipart: vi.fn(),
			listParts: vi.fn(async () => []),
			listMultipartUploads: vi.fn(async () => []),
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
		wakeDeletionWorker: vi.fn(),
		wakeMaintenance: vi.fn(),
		recordUntrackedMultipartCleanupFailure: vi.fn(),
		logger: { error: mocks.logError, warn: mocks.logWarn, fatal: vi.fn() },
	};
	return { deps, mocks };
}

describe('stale upload recovery', () => {
	it('stops before storage or state mutation when the DB completion claim is lost', async () => {
		const session = staleSession();
		const { deps, mocks } = createHarness(session);
		deps.repository.claimStaleCompletingSessions = vi.fn().mockResolvedValue([session]);
		deps.repository.renewCompletionClaim = vi.fn().mockResolvedValue({ count: 0 });
		deps.repository.releaseCompletionClaim = vi.fn().mockResolvedValue({ count: 0 });

		await expect(sweepStaleCompletingSessions(deps)).resolves.toEqual({ swept: 1 });

		expect(mocks.head).not.toHaveBeenCalled();
		expect(mocks.finalize).not.toHaveBeenCalled();
		expect(mocks.markFailed).not.toHaveBeenCalled();
		expect(deps.repository.releaseCompletionClaim).toHaveBeenCalledWith(
			'stale-upload',
			'id',
			'recovery-deferred',
		);
		expect(mocks.logWarn).toHaveBeenCalledWith(
			{ sessionId: 'stale-upload', completionClaimToken: 'id' },
			'Completing-session recovery claim was lost before deferred release',
		);
	});

	it('uses the normal finalizer when the completed source object exists', async () => {
		const session = staleSession();
		const { deps, mocks } = createHarness(session);

		await expect(sweepStaleCompletingSessions(deps)).resolves.toEqual({ swept: 1 });

		expect(mocks.claimStale).toHaveBeenCalledWith(
			new Date('2026-07-21T00:05:00.000Z'),
			'id',
			2 * 60 * 1000,
			50,
		);
		expect(mocks.finalize).toHaveBeenCalledWith({
			id: session.id,
			projectId: session.projectId,
			uploadKind: session.uploadKind,
			originalName: session.originalName,
			totalBytes: session.totalBytes,
			s3Key: session.s3Key,
			completionClaimToken: 'id',
		}, { size: 8, contentType: 'application/zip' }, {
			storageRequest: { signal: expect.any(AbortSignal) },
			assertClaimOwned: expect.any(Function),
		});
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

	it('atomically records terminal failure and deletion outbox for an invalid completed object', async () => {
		const { deps, mocks } = createHarness();
		mocks.finalize.mockRejectedValueOnce(badRequest('Unsafe ZIP path'));

		await expect(sweepStaleCompletingSessions(deps)).resolves.toEqual({ swept: 1 });

		expect(mocks.markCompletedObjectFailed).toHaveBeenCalledWith({
			sessionId: 'stale-upload',
			storageKey: 'webgl/7/deployment/source.zip',
			reason: 'webgl-upload-sweep-invalid',
			completionClaimToken: 'id',
		});
		expect(deps.wakeDeletionWorker).toHaveBeenCalledOnce();
		expect(mocks.markFailed).not.toHaveBeenCalled();
		expect(mocks.deleteOrQueue).not.toHaveBeenCalled();
	});

	it('does not terminalize when the atomic failure/outbox transaction fails', async () => {
		const { deps, mocks } = createHarness();
		mocks.finalize.mockRejectedValueOnce(badRequest('Unsafe ZIP path'));
		mocks.markCompletedObjectFailed.mockRejectedValueOnce(new Error('outbox unavailable'));

		await expect(sweepStaleCompletingSessions(deps))
			.resolves.toEqual({ swept: 1 });
		expect(mocks.markFailed).not.toHaveBeenCalled();
		expect(mocks.logError).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: 'stale-upload' }),
			'Completing-session recovery failed; continuing with the batch',
		);
	});

	it('returns an existing multipart to PENDING only after a successful not-found and ListParts check', async () => {
		const { deps, mocks } = createHarness();
		mocks.head.mockResolvedValueOnce(null);

		await expect(sweepStaleCompletingSessions(deps)).resolves.toEqual({ swept: 1 });

		expect(mocks.revertToPending).toHaveBeenCalledWith('stale-upload', 'id');
		expect(mocks.abortMultipart).not.toHaveBeenCalled();
		expect(mocks.markFailed).not.toHaveBeenCalled();
	});
});
