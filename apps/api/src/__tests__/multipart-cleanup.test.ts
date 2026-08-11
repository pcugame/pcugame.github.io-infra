import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { completeSession } from '../modules/admin/game-upload/complete-session.service.js';
import { createSession } from '../modules/admin/game-upload/create-session.service.js';
import { uploadChunk } from '../modules/admin/game-upload/upload-chunk.service.js';
import {
	aggregateBusinessAndCleanupError,
	cleanupUntrackedMultipart,
	MultipartBusinessCleanupError,
	UntrackedMultipartCleanupError,
} from '../modules/admin/game-upload/multipart-cleanup.js';
import type { GameUploadServiceDependencies } from '../modules/admin/game-upload/ports.js';
import { createDurableGameUploadRepository } from './helpers/upload-lifecycle.js';

function harness() {
	const abortMultipart = vi.fn(async () => undefined);
	const repository = createDurableGameUploadRepository({
		findExhibitionById: vi.fn(async () => ({
			id: 1,
			year: 2026,
			title: 'Exhibition',
			isUploadEnabled: true,
		})),
	});
	const wakeMaintenance = vi.fn();
	const recordUntrackedMultipartCleanupFailure = vi.fn();
	const logger = {
		error: vi.fn(),
		warn: vi.fn(),
		fatal: vi.fn(),
	};
	const deps: GameUploadServiceDependencies = {
		repository,
		storage: {
			createMultipart: vi.fn(async () => 'new-upload-id'),
			abortMultipart,
			uploadPart: vi.fn(),
			completeMultipart: vi.fn(),
			listParts: vi.fn(async () => []),
			listMultipartUploads: vi.fn(async () => []),
			head: vi.fn(async () => null),
		},
		finalizer: { finalize: vi.fn() },
		settings: { get: vi.fn(async () => ({ maxGameFileMb: 8, maxChunkSizeMb: 1 })) },
		uploadSlots: { acquire: vi.fn(), release: vi.fn() },
		clock: { now: () => new Date('2026-08-11T00:00:00.000Z') },
		ids: { next: () => 'new-session-id' },
		lifecycle: { isAcceptingNewWork: () => true },
		config: { uploadChunkSizeMb: 1, uploadSessionTtlMinutes: 60 },
		roleGameMaxBytes: () => 8 * 1024 * 1024,
		storageKey: () => 'new-object.zip',
		deleteOrQueue: vi.fn(async () => undefined),
		wakeDeletionWorker: vi.fn(),
		wakeMaintenance,
		recordUntrackedMultipartCleanupFailure,
		logger,
	};
	return {
		deps,
		repository,
		abortMultipart,
		wakeMaintenance,
		recordUntrackedMultipartCleanupFailure,
		logger,
	};
}

const target = {
	key: 'new-object.zip',
	uploadId: 'new-upload-id',
	reason: 'unused-replacement',
};

describe('untracked multipart cleanup durability', () => {
	it('finishes with a prompt abort without writing a redundant durable task', async () => {
		const { deps, repository, abortMultipart, wakeMaintenance } = harness();

		await expect(cleanupUntrackedMultipart(deps, target)).resolves.toBe('aborted');

		expect(abortMultipart).toHaveBeenCalledWith(target.key, target.uploadId, undefined);
		expect(repository.queueAbortTask).not.toHaveBeenCalled();
		expect(wakeMaintenance).not.toHaveBeenCalled();
	});

	it('durably queues the exact upload and wakes maintenance after prompt abort fails', async () => {
		const { deps, repository, abortMultipart, wakeMaintenance } = harness();
		abortMultipart.mockRejectedValueOnce(new Error('storage unavailable'));

		await expect(cleanupUntrackedMultipart(deps, target)).resolves.toBe('queued');

		expect(repository.queueAbortTask).toHaveBeenCalledWith(target);
		expect(wakeMaintenance).toHaveBeenCalledOnce();
	});

	it('throws and emits the dedicated critical signal when abort and durable queue both fail', async () => {
		const {
			deps,
			repository,
			abortMultipart,
			recordUntrackedMultipartCleanupFailure,
			logger,
		} = harness();
		const abortError = new Error('storage unavailable');
		const queueError = new Error('database unavailable');
		abortMultipart.mockRejectedValueOnce(abortError);
		vi.mocked(repository.queueAbortTask).mockRejectedValueOnce(queueError);

		let thrown: unknown;
		try {
			await cleanupUntrackedMultipart(deps, target);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(UntrackedMultipartCleanupError);
		expect(thrown).toMatchObject({
			key: target.key,
			uploadId: target.uploadId,
			reason: target.reason,
			abortError,
			queueError,
		});
		expect((thrown as AggregateError).errors).toEqual([abortError, queueError]);
		expect(recordUntrackedMultipartCleanupFailure).toHaveBeenCalledOnce();
		expect(logger.fatal).toHaveBeenCalledWith(
			expect.objectContaining({
				event: 'untracked_multipart_cleanup_unrecoverable',
				key: target.key,
				uploadId: target.uploadId,
				abortError,
				queueError,
			}),
			'CRITICAL: untracked multipart abort and durable queue both failed',
		);
	});

	it('preserves the business failure and both cleanup-channel failures', async () => {
		const { deps, repository, abortMultipart } = harness();
		const businessError = new Error('session transaction failed');
		const abortError = new Error('storage unavailable');
		const queueError = new Error('database unavailable');
		vi.mocked(repository.createSessionReplacingActive).mockRejectedValueOnce(businessError);
		abortMultipart.mockRejectedValueOnce(abortError);
		vi.mocked(repository.queueAbortTask).mockRejectedValueOnce(queueError);

		let thrown: unknown;
		try {
			await createSession(
				deps,
				7,
				1,
				{ id: 11, role: 'ADMIN' },
				{ originalName: 'game.zip', totalBytes: 1 },
			);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(AggregateError);
		const errors = (thrown as AggregateError).errors;
		expect(errors[0]).toBe(businessError);
		expect(errors[1]).toBeInstanceOf(UntrackedMultipartCleanupError);
		expect((errors[1] as AggregateError).errors).toEqual([abortError, queueError]);
	});

	it('keeps prompt abort best effort only when the repository returns durable-task evidence', async () => {
		const { deps, repository, abortMultipart, wakeMaintenance, logger } = harness();
		vi.mocked(repository.createSessionReplacingActive).mockResolvedValueOnce({
			session: { id: 'new-session-id' },
			durableAborts: [{
				tracking: 'durable-abort-task-committed',
				sessionId: 'old-session-id',
				key: 'old-object.zip',
				uploadId: 'old-upload-id',
				reason: 'active-upload-replaced',
			}],
		});
		abortMultipart.mockRejectedValueOnce(new Error('prompt abort unavailable'));

		await expect(createSession(
			deps,
			7,
			1,
			{ id: 11, role: 'ADMIN' },
			{ originalName: 'game.zip', totalBytes: 1 },
		)).resolves.toMatchObject({ sessionId: 'new-session-id' });

		expect(wakeMaintenance).toHaveBeenCalledOnce();
		expect(repository.queueAbortTask).not.toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: 'old-session-id',
				s3Key: 'old-object.zip',
				tracking: 'durable-abort-task-committed',
			}),
			'Failed to abort multipart upload while replacing active session',
		);
	});

	it('preserves generation persistence, abort, and durable-queue failures for an unused replacement', async () => {
		const {
			deps,
			repository,
			abortMultipart,
			recordUntrackedMultipartCleanupFailure,
		} = harness();
		const replacementError = new Error('generation transaction failed');
		const abortError = new Error('replacement abort failed');
		const queueError = new Error('replacement queue failed');
		vi.mocked(repository.findSessionById).mockResolvedValueOnce({
			id: 'session-id',
			projectId: 7,
			userId: 11,
			uploadKind: 'GAME',
			originalName: 'game.zip',
			totalBytes: 1n,
			chunkSizeBytes: 1,
			totalChunks: 1,
			uploadedChunks: [],
			status: 'PENDING',
			expiresAt: new Date('2026-08-12T00:00:00.000Z'),
			s3UploadId: 'old-upload-id',
			s3Key: 'new-object.zip',
			parts: [],
			multipartGeneration: 1,
			project: { status: 'PUBLISHED' },
		});
		vi.mocked(repository.acquirePartClaim).mockResolvedValueOnce({ kind: 'expired' });
		vi.mocked(repository.replaceMultipartGeneration).mockRejectedValueOnce(replacementError);
		abortMultipart.mockRejectedValueOnce(abortError);
		vi.mocked(repository.queueAbortTask).mockRejectedValueOnce(queueError);

		let thrown: unknown;
		try {
			await uploadChunk(
				deps,
				'session-id',
				0,
				Readable.from([Buffer.from([0])]),
				{ id: 11, role: 'ADMIN' },
			);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(MultipartBusinessCleanupError);
		expect((thrown as AggregateError).errors[0]).toBe(replacementError);
		const cleanup = (thrown as AggregateError).errors[1];
		expect(cleanup).toBeInstanceOf(UntrackedMultipartCleanupError);
		expect((cleanup as AggregateError).errors).toEqual([abortError, queueError]);
		expect(repository.queueAbortTask).toHaveBeenCalledWith({
			key: 'new-object.zip',
			uploadId: 'new-upload-id',
			reason: 'generation-reset-persistence-failed',
		});
		expect(recordUntrackedMultipartCleanupFailure).toHaveBeenCalledOnce();
		expect(deps.uploadSlots.release).toHaveBeenCalledOnce();
	});

	it('tracks a list-parts mismatch replacement when persistence and both cleanup channels fail', async () => {
		const {
			deps,
			repository,
			abortMultipart,
			recordUntrackedMultipartCleanupFailure,
		} = harness();
		const replacementError = new Error('mismatch generation transaction failed');
		const abortError = new Error('mismatch replacement abort failed');
		const queueError = new Error('mismatch replacement queue failed');
		vi.mocked(repository.findSessionById).mockResolvedValueOnce({
			id: 'session-id',
			projectId: 7,
			userId: 11,
			uploadKind: 'GAME',
			originalName: 'game.zip',
			totalBytes: 1n,
			chunkSizeBytes: 1,
			totalChunks: 1,
			uploadedChunks: [0],
			status: 'PENDING',
			expiresAt: new Date('2026-08-12T00:00:00.000Z'),
			s3UploadId: 'old-upload-id',
			s3Key: 'new-object.zip',
			parts: [{ partNumber: 1, etag: 'database-etag', generation: 1 }],
			multipartGeneration: 1,
			project: { status: 'PUBLISHED' },
		});
		vi.mocked(repository.findPartsBySessionId).mockResolvedValueOnce([
			{ partNumber: 1, etag: 'database-etag', generation: 1 },
		]);
		vi.mocked(deps.storage.listParts).mockResolvedValueOnce([
			{ partNumber: 1, etag: 'different-storage-etag' },
		]);
		vi.mocked(repository.replaceMultipartGeneration).mockRejectedValueOnce(replacementError);
		abortMultipart.mockRejectedValueOnce(abortError);
		vi.mocked(repository.queueAbortTask).mockRejectedValueOnce(queueError);

		let thrown: unknown;
		try {
			await completeSession(
				deps,
				'session-id',
				{ id: 11, role: 'ADMIN' },
			);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(MultipartBusinessCleanupError);
		const errors = (thrown as AggregateError).errors;
		expect(errors[0]).toMatchObject({ code: 'CONFLICT' });
		expect(errors[1]).toBe(replacementError);
		expect(errors[2]).toBeInstanceOf(UntrackedMultipartCleanupError);
		expect((errors[2] as AggregateError).errors).toEqual([abortError, queueError]);
		expect(repository.queueAbortTask).toHaveBeenCalledWith({
			key: 'new-object.zip',
			uploadId: 'new-upload-id',
			reason: 'list-parts-mismatch-reset-persistence-failed',
		});
		expect(recordUntrackedMultipartCleanupFailure).toHaveBeenCalledOnce();
	});

	it('can aggregate a pre-existing business error without discarding cleanup evidence', () => {
		const businessError = new Error('business failure');
		const cleanupError = new UntrackedMultipartCleanupError({
			...target,
			abortError: new Error('abort failure'),
			queueError: new Error('queue failure'),
		});

		const aggregate = aggregateBusinessAndCleanupError(
			businessError,
			cleanupError,
			'business and cleanup failed',
		);
		expect(aggregate.errors).toEqual([businessError, cleanupError]);
	});
});
