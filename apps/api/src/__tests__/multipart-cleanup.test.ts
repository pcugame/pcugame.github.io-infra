import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createSession } from '../modules/admin/game-upload/create-session.service.js';
import {
	cleanupUntrackedMultipart,
	UntrackedMultipartCleanupError,
} from '../modules/admin/game-upload/multipart-cleanup.js';
import type { GameUploadServiceDependencies } from '../modules/admin/game-upload/ports.js';
import { createDurableGameUploadRepository } from './helpers/upload-lifecycle.js';
import { sourceIdentityRoot } from '../modules/admin/game-upload/source-identity.js';

function sourceForBuffer(file: Buffer) {
	const digest = createHash('sha256').update(file).digest('hex');
	return {
		sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1' as const,
		sourceIdentity: sourceIdentityRoot(file.length, 1_048_576, [digest]),
		sourceIdentityBlockSizeBytes: 1_048_576,
		sourceIdentityBlockManifest: Buffer.from(digest, 'hex'),
		sourceIdentityBlockDigests: [digest],
	};
}

function harness() {
	const abortMultipart = vi.fn(async () => undefined);
	const repository = createDurableGameUploadRepository({
		findExhibitionById: vi.fn(async () => ({
			id: 1, year: 2026, title: 'Exhibition', isUploadEnabled: true,
		})),
	});
	const wakeMaintenance = vi.fn();
	const recordUntrackedMultipartCleanupFailure = vi.fn();
	const logger = { error: vi.fn(), warn: vi.fn(), fatal: vi.fn() };
	const deps: GameUploadServiceDependencies = {
		repository,
		storage: {
			createMultipart: vi.fn(async () => 'new-upload-id'),
			abortMultipart,
			completeMultipart: vi.fn(),
			listParts: vi.fn(async () => []),
			listMultipartUploads: vi.fn(async () => []),
			head: vi.fn(async () => null),
		},
		partSigner: { presignUploadPart: vi.fn(async () => 'https://storage.test/part') },
		settings: { get: vi.fn(async () => ({ maxGameFileMb: 8, maxChunkSizeMb: 5 })) },
		clock: { now: () => new Date('2026-08-11T00:00:00.000Z') },
		ids: { next: () => 'new-session-id' },
		lifecycle: { isAcceptingNewWork: () => true },
		authorizeProjectWrite: vi.fn(async () => undefined),
		config: { uploadChunkSizeMb: 5, uploadSessionTtlMinutes: 60, uploadPartUrlBatchMax: 16, uploadPartUrlTtlSeconds: 300, uploadPartUrlRefreshMax: 64, uploadPartUrlRefreshWindowMs: 300_000, directUploadQuota: { actorActiveSessions: 4, projectActiveSessions: 2, actorOutstandingBytes: 10n * 1024n * 1024n * 1024n } },
		roleGameMaxBytes: () => 8 * 1024 * 1024,
		storageKey: () => 'new-object.zip',
		deleteOrQueue: vi.fn(async () => undefined),
		wakeDeletionWorker: vi.fn(),
		wakeMaintenance,
		recordUntrackedMultipartCleanupFailure,
		logger,
	};
	return { deps, repository, abortMultipart, wakeMaintenance, recordUntrackedMultipartCleanupFailure, logger };
}

const target = { key: 'new-object.zip', uploadId: 'new-upload-id', reason: 'unused-replacement' };

describe('untracked direct multipart cleanup durability', () => {
	it('finishes with a prompt exact abort without a redundant durable task', async () => {
		const { deps, repository, abortMultipart, wakeMaintenance } = harness();
		await expect(cleanupUntrackedMultipart(deps, target)).resolves.toBe('aborted');
		expect(abortMultipart).toHaveBeenCalledWith(target.key, target.uploadId, undefined);
		expect(repository.queueAbortTask).not.toHaveBeenCalled();
		expect(wakeMaintenance).not.toHaveBeenCalled();
	});

	it('durably queues the exact upload when prompt abort fails', async () => {
		const { deps, repository, abortMultipart, wakeMaintenance } = harness();
		abortMultipart.mockRejectedValueOnce(new Error('storage unavailable'));
		await expect(cleanupUntrackedMultipart(deps, target)).resolves.toBe('queued');
		expect(repository.queueAbortTask).toHaveBeenCalledWith(target);
		expect(wakeMaintenance).toHaveBeenCalledOnce();
	});

	it('redacts upload IDs and signed URLs if abort and queue both fail', async () => {
		const { deps, repository, abortMultipart, recordUntrackedMultipartCleanupFailure, logger } = harness();
		abortMultipart.mockRejectedValueOnce(new Error(
			`storage unavailable ${target.uploadId} https://garage.test/object?X-Amz-Signature=secret`,
		));
		vi.mocked(repository.queueAbortTask).mockRejectedValueOnce(new Error(`db uploadId=${target.uploadId}`));
		const failure = await cleanupUntrackedMultipart(deps, target).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(UntrackedMultipartCleanupError);
		expect(JSON.stringify(failure)).not.toContain(target.key);
		expect(JSON.stringify(failure)).not.toContain(target.uploadId);
		expect(JSON.stringify(failure)).not.toContain('X-Amz-Signature');
		expect((failure as Error).message).toBe('Untracked multipart cleanup failed');
		expect(recordUntrackedMultipartCleanupFailure).toHaveBeenCalledOnce();
		const fatalContext = logger.fatal.mock.calls[0]?.[0];
		expect(JSON.stringify(fatalContext)).not.toContain(target.uploadId);
		expect(JSON.stringify(fatalContext)).not.toContain('X-Amz-Signature');
	});

	it('preserves the business error when session persistence and cleanup both fail', async () => {
		const { deps, repository, abortMultipart } = harness();
		const businessError = new Error('session transaction failed');
		vi.mocked(repository.createSessionReplacingActive).mockRejectedValueOnce(businessError);
		abortMultipart.mockRejectedValueOnce(new Error('storage unavailable'));
		vi.mocked(repository.queueAbortTask).mockRejectedValueOnce(new Error('database unavailable'));
		const failure = await createSession(
			deps, 7, 1, { id: 11, role: 'ADMIN' },
			{ originalName: 'game.zip', totalBytes: 1, ...sourceForBuffer(Buffer.from([0])) },
		).catch((error: unknown) => error);
		expect(failure).toMatchObject({
			name: 'MultipartBusinessCleanupError',
			code: 'BUSINESS_AND_MULTIPART_CLEANUP_FAILED',
			message: 'Business operation and multipart cleanup failed',
		});
		expect(JSON.stringify(failure)).not.toContain(businessError.message);
		expect(JSON.stringify(failure)).not.toContain(target.key);
		expect(JSON.stringify(failure)).not.toContain(target.uploadId);
	});

	it('relies on durable replacement evidence before prompt abort', async () => {
		const { deps, repository, abortMultipart, wakeMaintenance } = harness();
		vi.mocked(repository.createSessionReplacingActive).mockResolvedValueOnce({
			session: { id: 'new-session-id' },
			durableAborts: [{
				tracking: 'durable-abort-task-committed', sessionId: 'old-session-id',
				key: 'old-object.zip', uploadId: 'old-upload-id', reason: 'active-upload-replaced',
			}],
		});
		abortMultipart.mockRejectedValueOnce(new Error('prompt abort unavailable'));
		await expect(createSession(
			deps, 7, 1, { id: 11, role: 'ADMIN' },
			{ originalName: 'game.zip', totalBytes: 1, ...sourceForBuffer(Buffer.from([0])) },
		)).resolves.toMatchObject({ sessionId: 'new-session-id', generation: 1 });
		expect(wakeMaintenance).toHaveBeenCalledOnce();
	});
});
