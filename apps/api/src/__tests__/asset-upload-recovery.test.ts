import { describe, expect, it, vi } from 'vitest';
import { createAssetUploadRecoveryService } from '../modules/asset-upload/recovery.service.js';
import type { AssetUploadRepository, AssetUploadSessionRecord } from '../modules/asset-upload/ports.js';

const now = new Date('2026-08-21T00:30:00.000Z');
const old = new Date(now.getTime() - (16 * 60 * 1_000));

function session(overrides: Partial<AssetUploadSessionRecord> = {}): AssetUploadSessionRecord {
	return {
		id: '11111111-1111-4111-8111-111111111111',
		projectId: 7,
		exhibitionId: null,
		userId: 11,
		kind: 'GAME',
		state: 'COMPLETING',
		originalName: 'game.zip',
		declaredMimeType: 'application/zip',
		totalBytes: 7n,
		partSizeBytes: 5,
		totalParts: 2,
		bucket: 'protected-bucket',
		objectKey: 'protected/uploads/11111111-1111-4111-8111-111111111111/1/source.zip',
		uploadId: 'garage-upload-1',
		generation: 1,
		sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1',
		sourceIdentity: 'a'.repeat(64),
		sourceIdentityBlockSizeBytes: 1024,
		sourceIdentityBlockManifest: '',
		completionLeaseToken: 'claim-1',
		completionLeaseUntil: new Date(now.getTime() + 120_000),
		completionResult: null,
		validationLeaseToken: null,
		validationLeaseUntil: null,
		expectedTargetAssetId: null,
		expectedTargetAssetUpdatedAt: null,
		resultAssetId: null,
		resultRepresentationId: null,
		expiresAt: new Date(now.getTime() + 60 * 60 * 1_000),
		...overrides,
	};
}

function harness(options: {
	claimed?: AssetUploadSessionRecord[];
	head?: Array<{ size: number; etag?: string } | null>;
	parts?: Array<{ partNumber: number; etag: string; sizeBytes: number }>;
	uploads?: Array<{ key: string; uploadId: string; initiated?: Date }>;
} = {}) {
	const repository = {
		expireTimedOutSessions: vi.fn(async () => ({ expired: 0, aborts: 0 })),
		claimExpiredCompletions: vi.fn(async () => options.claimed ?? []),
		renewCompletion: vi.fn(async () => true),
		markVerifying: vi.fn(async () => true),
		releaseRecoveredCompletion: vi.fn(async () => 'released' as const),
		rejectRecoveredCompletion: vi.fn(async () => true),
		queueUnknownMultipartAborts: vi.fn(async ({ uploads }) => uploads.length),
	} as unknown as AssetUploadRepository;
	const heads = [...(options.head ?? [])];
	const storage = {
		head: vi.fn(async () => heads.shift() ?? null),
		listParts: vi.fn(async () => options.parts ?? [
			{ partNumber: 1, etag: 'one', sizeBytes: 5 },
			{ partNumber: 2, etag: 'two', sizeBytes: 2 },
		]),
		completeMultipart: vi.fn(async () => undefined),
		listMultipartUploads: vi.fn(async () => options.uploads ?? []),
	};
	const logger = { error: vi.fn() };
	const wakeMaintenance = vi.fn();
	const recovery = createAssetUploadRecoveryService({
		repository,
		storage,
		clock: { now: () => now },
		ids: { next: () => 'claim-1' },
		logger,
		wakeMaintenance,
		bucket: 'protected-bucket',
	});
	return { recovery, repository, storage, logger, wakeMaintenance };
}

describe('canonical direct multipart recovery', () => {
	it('retries a lease-expired completion from Garage ListParts and atomically converges to VERIFYING', async () => {
		const { recovery, repository, storage } = harness({
			claimed: [session()],
			head: [null, { size: 7, etag: '"complete-etag"' }],
		});

		await expect(recovery.recover()).resolves.toMatchObject({
			completionClaimed: 1,
			completionVerified: 1,
			completionRetried: 0,
		});
		expect(storage.completeMultipart).toHaveBeenCalledWith(
			'protected-bucket',
			expect.stringContaining('/source.zip'),
			'garage-upload-1',
			[
				{ partNumber: 1, etag: 'one', sizeBytes: 5 },
				{ partNumber: 2, etag: 'two', sizeBytes: 2 },
			],
			expect.any(Object),
		);
		expect(repository.markVerifying).toHaveBeenCalledWith(expect.objectContaining({
			sessionId: session().id,
			generation: 1,
			completedSize: 7,
			result: expect.objectContaining({ etag: '"complete-etag"' }),
		}));
	});

	it('reconciles an already completed object without another CompleteMultipart call after a crash', async () => {
		const { recovery, repository, storage } = harness({
			claimed: [session()],
			head: [{ size: 7, etag: 'already-complete' }],
		});

		await expect(recovery.recover()).resolves.toMatchObject({ completionVerified: 1 });
		expect(storage.listParts).not.toHaveBeenCalled();
		expect(storage.completeMultipart).not.toHaveBeenCalled();
		expect(repository.markVerifying).toHaveBeenCalledOnce();
	});

	it('returns malformed but still-live multipart work to UPLOADING, preserving a resume path', async () => {
		const { recovery, repository, storage } = harness({
			claimed: [session()],
			head: [null],
			parts: [{ partNumber: 1, etag: 'one', sizeBytes: 5 }],
		});

		await expect(recovery.recover()).resolves.toMatchObject({ completionReleased: 1 });
		expect(repository.releaseRecoveredCompletion).toHaveBeenCalledWith(expect.objectContaining({
			sessionId: session().id,
			generation: 1,
			token: 'claim-1',
		}));
		expect(storage.completeMultipart).not.toHaveBeenCalled();
	});

	it('retains a claimed completion when Garage is unavailable, rather than falsely returning it to a browser', async () => {
		const { recovery, repository, storage, logger } = harness({ claimed: [session()] });
		storage.head.mockRejectedValueOnce(new Error('Garage unavailable'));

		await expect(recovery.recover()).resolves.toMatchObject({ completionRetried: 1 });
		expect(repository.releaseRecoveredCompletion).not.toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ sessionId: session().id }), expect.stringContaining('will retry'));
	});

	it('terminalizes a size-mismatched completed object and wakes durable cleanup', async () => {
		const { recovery, repository, wakeMaintenance } = harness({
			claimed: [session()],
			head: [{ size: 8 }],
		});

		await expect(recovery.recover()).resolves.toMatchObject({ completionRejected: 1 });
		expect(repository.rejectRecoveredCompletion).toHaveBeenCalledWith(expect.objectContaining({
			reason: expect.stringContaining('size mismatch'),
		}));
		expect(wakeMaintenance).toHaveBeenCalledOnce();
	});

	it('terminalizes a lease-taken-over completion when Garage has neither object nor multipart upload', async () => {
		const { recovery, repository, storage, wakeMaintenance } = harness({
			claimed: [session()],
			head: [null],
		});
		storage.listParts.mockRejectedValueOnce({ name: 'NoSuchUpload', $metadata: { httpStatusCode: 404 } });

		await expect(recovery.recover()).resolves.toMatchObject({
			completionClaimed: 1,
			completionRejected: 1,
			completionRetried: 0,
		});
		expect(repository.rejectRecoveredCompletion).toHaveBeenCalledWith(expect.objectContaining({
			reason: expect.stringContaining('no longer has the incomplete multipart upload'),
		}));
		expect(wakeMaintenance).toHaveBeenCalledOnce();
	});

	it('terminalizes when multipart disappears between ListParts and CompleteMultipart after HEAD proves no object', async () => {
		const { recovery, repository, storage, wakeMaintenance } = harness({
			claimed: [session()],
			head: [null, null],
		});
		storage.completeMultipart.mockRejectedValueOnce({ name: 'NoSuchUpload', $metadata: { httpStatusCode: 404 } });

		await expect(recovery.recover()).resolves.toMatchObject({ completionRejected: 1, completionRetried: 0 });
		expect(repository.rejectRecoveredCompletion).toHaveBeenCalledWith(expect.objectContaining({
			reason: expect.stringContaining('no longer has the incomplete multipart upload'),
		}));
		expect(wakeMaintenance).toHaveBeenCalledOnce();
	});

	it('queues only old UUID-namespace inventory uploads, never young, foreign, or timestamp-less entries', async () => {
		const eligible = session().objectKey;
		const { recovery, repository } = harness({
			uploads: [
				{ key: eligible, uploadId: 'orphaned', initiated: old },
				{ key: eligible.replace('/1/', '/2/'), uploadId: 'young', initiated: new Date(now.getTime() - 1_000) },
				{ key: 'protected/exports/11111111-1111-4111-8111-111111111111/1/source.zip', uploadId: 'foreign', initiated: old },
				{ key: eligible.replace('11111111', 'not-a-session'), uploadId: 'malformed', initiated: old },
				{ key: eligible.replace('/1/', '/3/'), uploadId: 'unknown-age' },
			],
		});

		await expect(recovery.recover()).resolves.toMatchObject({ inventoryQueued: 1 });
		expect(repository.queueUnknownMultipartAborts).toHaveBeenCalledWith({
			bucket: 'protected-bucket',
			uploads: [{ key: eligible, uploadId: 'orphaned' }],
		});
	});

	it('does not duplicate recovery work when a concurrent claimant receives no leased session', async () => {
		const current = session();
		const { recovery, repository, storage } = harness({ claimed: [current], head: [{ size: 7 }] });
		(repository.claimExpiredCompletions as unknown as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce([current])
			.mockResolvedValueOnce([]);

		const [first, second] = await Promise.all([recovery.recover(), recovery.recover()]);
		expect(first.completionVerified + second.completionVerified).toBe(1);
		expect(storage.completeMultipart).not.toHaveBeenCalled();
		expect(repository.markVerifying).toHaveBeenCalledOnce();
	});
});
