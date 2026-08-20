import { describe, expect, it, vi } from 'vitest';
import type { GameUploadServiceDependencies } from '../modules/admin/game-upload/ports.js';
import {
	sweepExpiredPartClaims,
	sweepUntrackedMultipartUploads,
} from '../modules/admin/game-upload/session-maintenance.service.js';
import {
	MultipartBusinessCleanupError,
	UntrackedMultipartCleanupError,
} from '../modules/admin/game-upload/multipart-cleanup.js';
import { createDurableGameUploadRepository } from './helpers/upload-lifecycle.js';

function maintenanceDeps(): GameUploadServiceDependencies {
	return {
		repository: createDurableGameUploadRepository({
			findSessionById: vi.fn(),
			createSessionReplacingActive: vi.fn(),
			cancelSessionAndClearActive: vi.fn(),
			findPartsBySessionId: vi.fn(),
			revertToPending: vi.fn(),
			markFailed: vi.fn(),
			findActiveSessionsForListing: vi.fn(),
			findExhibitionById: vi.fn(),
		}),
		storage: {
			createMultipart: vi.fn(),
			abortMultipart: vi.fn(),
			uploadPart: vi.fn(),
			completeMultipart: vi.fn(),
			listParts: vi.fn(async () => []),
			listMultipartUploads: vi.fn(async () => []),
			head: vi.fn(),
		},
		partSigner: { presignUploadPart: vi.fn(async () => 'https://storage.test/part') },
		finalizer: { finalize: vi.fn() },
		settings: { get: vi.fn() },
		uploadSlots: { acquire: vi.fn(), release: vi.fn() },
		clock: { now: () => new Date('2026-08-11T12:00:00.000Z') },
		ids: { next: () => 'id' },
		lifecycle: { isAcceptingNewWork: () => true },
		authorizeProjectWrite: vi.fn(async () => undefined),
		config: { uploadChunkSizeMb: 5, uploadSessionTtlMinutes: 60, uploadPartUrlBatchMax: 16, uploadPartUrlTtlSeconds: 300 },
		roleGameMaxBytes: () => 1024,
		storageKey: () => 'key',
		deleteOrQueue: vi.fn(),
		wakeDeletionWorker: vi.fn(),
		wakeMaintenance: vi.fn(),
		wakeValidationWorker: vi.fn(),
		recordUntrackedMultipartCleanupFailure: vi.fn(),
		logger: { error: vi.fn(), warn: vi.fn(), fatal: vi.fn() },
	};
}

describe('multipart lifecycle maintenance', () => {
	it('replaces the whole generation for an expired part claim', async () => {
		const deps = maintenanceDeps();
		deps.repository.findSessionsWithExpiredPartClaims = vi.fn().mockResolvedValue([{
			id: 'session',
			projectId: 1,
			userId: 1,
			uploadKind: 'GAME',
			originalName: 'game.zip',
			totalBytes: 10n,
			chunkSizeBytes: 5,
			totalChunks: 2,
			uploadedChunks: [0],
			status: 'PENDING',
			expiresAt: new Date('2026-08-12T00:00:00.000Z'),
			s3UploadId: 'old-upload',
			s3Key: 'game.zip',
			multipartGeneration: 3,
		}]);
		deps.repository.replaceMultipartGeneration = vi.fn().mockResolvedValue({
			replaced: true,
			durableAbort: {
				tracking: 'durable-abort-task-committed',
				sessionId: 'session',
				key: 'game.zip',
				uploadId: 'old-upload',
				reason: 'expired-part-claim-maintenance-reset',
			},
		});
		vi.mocked(deps.storage.createMultipart).mockResolvedValue('new-upload');
		vi.mocked(deps.storage.abortMultipart).mockResolvedValue(undefined);

		await expect(sweepExpiredPartClaims(deps)).resolves.toEqual({ swept: 1 });
		expect(deps.repository.replaceMultipartGeneration).toHaveBeenCalledWith({
			sessionId: 'session',
			expectedGeneration: 3,
			newUploadId: 'new-upload',
			reason: 'expired-part-claim-maintenance-reset',
		});
		expect(deps.storage.abortMultipart).toHaveBeenCalledWith('game.zip', 'old-upload');
		expect(deps.wakeMaintenance).toHaveBeenCalledOnce();
	});

	it('surfaces an unused replacement when persistence, abort, and durable queue all fail', async () => {
		const deps = maintenanceDeps();
		deps.repository.findSessionsWithExpiredPartClaims = vi.fn().mockResolvedValue([{
			id: 'session',
			projectId: 1,
			userId: 1,
			uploadKind: 'GAME',
			originalName: 'game.zip',
			totalBytes: 1n,
			chunkSizeBytes: 1,
			totalChunks: 1,
			uploadedChunks: [],
			status: 'PENDING',
			expiresAt: new Date('2026-08-12T00:00:00.000Z'),
			s3UploadId: 'old-upload',
			s3Key: 'game.zip',
			multipartGeneration: 1,
		}]);
		const replacementError = new Error('generation transaction failed');
		const abortError = new Error('replacement abort failed');
		const queueError = new Error('replacement queue failed');
		deps.repository.replaceMultipartGeneration = vi.fn().mockRejectedValue(replacementError);
		vi.mocked(deps.storage.createMultipart).mockResolvedValue('new-upload');
		vi.mocked(deps.storage.abortMultipart).mockRejectedValue(abortError);
		deps.repository.queueAbortTask = vi.fn().mockRejectedValue(queueError);

		let thrown: unknown;
		try {
			await sweepExpiredPartClaims(deps);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(MultipartBusinessCleanupError);
		expect((thrown as AggregateError).errors[0]).toBe(replacementError);
		const cleanup = (thrown as AggregateError).errors[1];
		expect(cleanup).toBeInstanceOf(UntrackedMultipartCleanupError);
		expect((cleanup as AggregateError).errors).toEqual([abortError, queueError]);
		expect(deps.repository.queueAbortTask).toHaveBeenCalledWith({
			key: 'game.zip',
			uploadId: 'new-upload',
			reason: 'expired-part-claim-reset-persistence-failed',
		});
		expect(deps.recordUntrackedMultipartCleanupFailure).toHaveBeenCalledOnce();
	});

	it('queues only aged, app-owned, untracked multipart uploads', async () => {
		const deps = maintenanceDeps();
		const gameKey = '11111111-1111-4111-8111-111111111111.zip';
		const webglKey = 'webgl/7/22222222-2222-4222-8222-222222222222/source.zip';
		deps.storage.listMultipartUploads = vi.fn().mockResolvedValue([
			{ key: gameKey, uploadId: 'game', initiated: new Date('2026-08-11T10:00:00.000Z') },
			{ key: webglKey, uploadId: 'known', initiated: new Date('2026-08-11T10:00:00.000Z') },
			{ key: 'someone-else/data.bin', uploadId: 'foreign', initiated: new Date('2026-08-11T10:00:00.000Z') },
			{ key: '33333333-3333-4333-8333-333333333333.zip', uploadId: 'recent', initiated: new Date('2026-08-11T11:30:00.000Z') },
		]);
		deps.repository.findKnownMultipartUploads = vi.fn().mockResolvedValue([
			{ s3Key: webglKey, s3UploadId: 'known' },
		]);
		deps.repository.queueAbortTask = vi.fn().mockResolvedValue(undefined);

		await expect(sweepUntrackedMultipartUploads(deps)).resolves.toEqual({ queued: 1 });
		expect(deps.repository.queueAbortTask).toHaveBeenCalledWith({
			key: gameKey,
			uploadId: 'game',
			reason: 'untracked-multipart-age-fence',
		});
	});

	it('forwards the maintenance AbortSignal to multipart storage inspection', async () => {
		const deps = maintenanceDeps();
		const controller = new AbortController();
		deps.storage.listMultipartUploads = vi.fn().mockResolvedValue([]);
		deps.repository.findKnownMultipartUploads = vi.fn().mockResolvedValue([]);
		deps.repository.queueAbortTask = vi.fn();

		await expect(sweepUntrackedMultipartUploads(deps, controller.signal))
			.resolves.toEqual({ queued: 0 });
		expect(deps.storage.listMultipartUploads).toHaveBeenCalledWith('', {
			signal: controller.signal,
		});
	});

	it('does not start a multipart sweep after shutdown aborts maintenance', async () => {
		const deps = maintenanceDeps();
		const controller = new AbortController();
		controller.abort();
		deps.repository.findSessionsWithExpiredPartClaims = vi.fn();

		await expect(sweepExpiredPartClaims(deps, controller.signal))
			.resolves.toEqual({ swept: 0 });
		expect(deps.repository.findSessionsWithExpiredPartClaims).not.toHaveBeenCalled();
	});
});
