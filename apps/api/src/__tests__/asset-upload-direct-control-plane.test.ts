import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SOURCE_IDENTITY_BLOCK_SIZE_BYTES, sourceIdentityRoot } from '../modules/admin/game-upload/source-identity.js';
import { createAssetUploadService } from '../modules/asset-upload/service.js';
import type { AssetUploadRepository, AssetUploadSessionRecord } from '../modules/asset-upload/ports.js';

function sourceProof(bytes: Buffer) {
	const digests = [createHash('sha256').update(bytes).digest('hex')];
	return {
		sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1' as const,
		sourceIdentity: sourceIdentityRoot(bytes.length, SOURCE_IDENTITY_BLOCK_SIZE_BYTES, digests),
		sourceIdentityBlockSizeBytes: SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
		sourceIdentityBlockDigests: digests,
	};
}

function session(overrides: Partial<AssetUploadSessionRecord> = {}): AssetUploadSessionRecord {
	return {
		id: 'direct-game-1', projectId: 7, exhibitionId: null, userId: 11, kind: 'GAME', state: 'UPLOADING', originalName: 'game.zip', declaredMimeType: 'application/zip',
		totalBytes: 7n, partSizeBytes: 5, totalParts: 2, bucket: 'protected', objectKey: 'protected/uploads/direct-game-1/1/source.zip', uploadId: 'garage-upload-1', generation: 1,
		sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'a'.repeat(64), sourceIdentityBlockSizeBytes: SOURCE_IDENTITY_BLOCK_SIZE_BYTES, sourceIdentityBlockManifest: '',
		completionLeaseToken: null, completionLeaseUntil: null, completionResult: null, validationLeaseToken: null, validationLeaseUntil: null,
		expectedTargetAssetId: null, expectedTargetAssetUpdatedAt: null, resultAssetId: null, resultRepresentationId: null,
		expiresAt: new Date('2026-09-01T00:00:00.000Z'), ...overrides,
	};
}

function harness(current = session()) {
	const wakeMaintenance = vi.fn();
	const repository = {
		createAllocating: vi.fn(async (value) => session({ ...value, state: 'ALLOCATING', uploadId: null })),
		expireStaleAllocations: vi.fn(async () => 0),
		setAllocated: vi.fn(async () => true), findById: vi.fn(async () => current),
		cancel: vi.fn(async () => ({ cancelled: true })),
		reservePartCapabilities: vi.fn(async () => current), claimCompletion: vi.fn(async () => 'claimed' as const), renewCompletion: vi.fn(async () => true),
		markVerifying: vi.fn(async () => true), revertUploading: vi.fn(async () => true), queueAbort: vi.fn(async () => undefined),
		claimVerifying: vi.fn(async () => []), renewValidation: vi.fn(async () => true), commitGameReady: vi.fn(), markRejected: vi.fn(),
	} as unknown as AssetUploadRepository;
	const storage = {
		createMultipart: vi.fn(async () => 'garage-upload-1'),
		listParts: vi.fn(async () => [{ partNumber: 1, etag: '"one"', sizeBytes: 5 }, { partNumber: 2, etag: 'two', sizeBytes: 2 }]),
		completeMultipart: vi.fn(async () => undefined),
		head: vi.fn(async () => ({ size: 7, etag: ' W/"garage-opaque-2" ' })),
		abortMultipart: vi.fn(),
	};
	const service = createAssetUploadService({
		repository, storage, partSigner: { presignUploadPart: vi.fn(async (_b, _k, _u, part) => `https://garage.test/part/${part}`) },
		clock: { now: () => new Date('2026-08-21T00:00:00.000Z') }, ids: { next: () => 'direct-game-1' },
		config: { bucket: 'protected', sessionTtlMs: 60_000, partSizeBytes: 5, partUrlTtlSeconds: 60, partUrlIssueWindowMs: 60_000, partUrlIssueMax: 20, maxBytesFor: () => 100 },
		authorizeProjectWrite: vi.fn(async () => ({ exhibitionId: 1, status: 'PUBLISHED' })),
		authorizeExhibitionWrite: vi.fn(async () => undefined),
		wakeMaintenance,
	});
	return { service, repository, storage, wakeMaintenance };
}

describe('canonical direct GAME control plane', () => {
	it('persists ALLOCATING before Garage allocation and never exposes an API UploadPart body path', async () => {
		const { service, repository, storage } = harness();
		const bytes = Buffer.from('fixture');
		await expect(service.createGameSession({ id: 11, role: 'USER' }, 7, { originalName: 'game.zip', totalBytes: bytes.length, ...sourceProof(bytes) })).resolves.toMatchObject({ generation: 1, totalParts: 2 });
		expect(repository.createAllocating).toHaveBeenCalledBefore(storage.createMultipart as never);
		expect(repository.expireStaleAllocations).toHaveBeenCalledWith({ type: 'PROJECT', id: 7 });
		expect(storage).not.toHaveProperty('uploadPart');
	});

	it('creates IMAGE/POSTER sessions with exactly one authorized domain owner', async () => {
		const { service, repository } = harness();
		const bytes = Buffer.from('fixture');
		await expect(service.createImageSession({ id: 11, role: 'USER' }, 7, {
			originalName: 'photo.png', totalBytes: bytes.length, declaredMimeType: 'image/png', ...sourceProof(bytes),
		})).resolves.toMatchObject({ owner: { type: 'PROJECT', id: 7 } });
		expect(repository.createAllocating).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'IMAGE', projectId: 7, exhibitionId: null }));
		await expect(service.createExhibitionPosterSession({ id: 11, role: 'ADMIN' }, 9, {
			originalName: 'poster.pdf', totalBytes: bytes.length, declaredMimeType: 'application/pdf', ...sourceProof(bytes),
		})).resolves.toMatchObject({ owner: { type: 'EXHIBITION', id: 9 } });
		expect(repository.createAllocating).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'POSTER', projectId: null, exhibitionId: 9 }));
	});

	it('uses Garage ListParts as the completion authority and transitions only to VERIFYING', async () => {
		const { service, storage, repository } = harness();
		await expect(service.complete({ id: 11, role: 'USER' }, 'direct-game-1', { generation: 1, parts: [{ partNumber: 2, etag: 'two', sizeBytes: 2 }, { partNumber: 1, etag: 'one', sizeBytes: 5 }] })).resolves.toMatchObject({ status: 'VERIFYING' });
		expect(storage.completeMultipart).toHaveBeenCalledWith('protected', expect.any(String), 'garage-upload-1', [{ partNumber: 1, etag: '"one"', sizeBytes: 5 }, { partNumber: 2, etag: 'two', sizeBytes: 2 }]);
		expect(repository.markVerifying).toHaveBeenCalledWith(expect.objectContaining({
			completedSize: 7,
			result: {
				status: 'VERIFYING', sessionId: 'direct-game-1', generation: 1, sizeBytes: 7,
				etag: 'W/"garage-opaque-2"',
			},
		}));
		expect((repository.markVerifying as ReturnType<typeof vi.fn>).mock.calls[0]![0].result)
			.not.toHaveProperty('checksum');
	});

	it('persists multipart ETag provenance when HEAD recovers an ambiguous CompleteMultipart failure', async () => {
		const { service, storage, repository } = harness();
		storage.completeMultipart.mockRejectedValueOnce(new Error('Garage connection reset'));
		storage.head.mockResolvedValueOnce({ size: 7, etag: '"deadbeef-2"' });

		await expect(service.complete(
			{ id: 11, role: 'USER' },
			'direct-game-1',
			{ generation: 1, parts: [
				{ partNumber: 1, etag: 'one', sizeBytes: 5 },
				{ partNumber: 2, etag: 'two', sizeBytes: 2 },
			] },
		)).resolves.toMatchObject({ status: 'VERIFYING' });
		expect(repository.markVerifying).toHaveBeenCalledWith(expect.objectContaining({
			result: expect.objectContaining({ etag: '"deadbeef-2"' }),
		}));
		expect(repository.revertUploading).not.toHaveBeenCalled();
	});

	it('rejects a client manifest that disagrees with Garage', async () => {
		const { service, storage } = harness();
		await expect(service.complete({ id: 11, role: 'USER' }, 'direct-game-1', { generation: 1, parts: [{ partNumber: 1, etag: 'forged', sizeBytes: 5 }, { partNumber: 2, etag: 'two', sizeBytes: 2 }] })).rejects.toMatchObject({ statusCode: 409 });
		expect(storage.completeMultipart).not.toHaveBeenCalled();
	});

	it('allocates WEBGL through the same byte-free multipart control path', async () => {
		const { service, repository, storage } = harness();
		const bytes = Buffer.from('webgl-fixture');
		await expect(service.createWebglSession({ id: 11, role: 'USER' }, 7, {
			originalName: 'webgl.zip', totalBytes: bytes.length, ...sourceProof(bytes),
		})).resolves.toMatchObject({ generation: 1, totalParts: 3 });
		expect(repository.createAllocating).toHaveBeenCalledWith(expect.objectContaining({ kind: 'WEBGL' }));
		expect(storage.createMultipart).toHaveBeenCalledWith('protected', expect.stringContaining('/source.zip'), 'application/zip');
	});

	it('allocates VIDEO as opaque bytes and leaves MIME verification to the worker', async () => {
		const { service, repository, storage } = harness();
		const bytes = Buffer.from('video-fixture');
		await expect(service.createVideoSession({ id: 11, role: 'USER' }, 7, {
			originalName: 'demo.mp4', totalBytes: bytes.length, ...sourceProof(bytes),
		})).resolves.toMatchObject({ generation: 1, totalParts: 3 });
		expect(repository.createAllocating).toHaveBeenCalledWith(expect.objectContaining({
			kind: 'VIDEO', declaredMimeType: '', objectKey: expect.stringMatching(/source\.bin$/),
		}));
		expect(storage.createMultipart).toHaveBeenCalledWith('protected', expect.stringMatching(/source\.bin$/), 'application/octet-stream');
	});

	it('treats durable CANCELLED as an idempotent cancel and wakes maintenance after success', async () => {
		const current = session({ state: 'CANCELLED', uploadId: null });
		const { service, repository, wakeMaintenance } = harness(current);
		(repository.cancel as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ cancelled: true });

		await expect(service.cancel({ id: 11, role: 'USER' }, current.id)).resolves.toBeUndefined();
		expect(repository.cancel).toHaveBeenCalledWith(current.id, current.userId);
		expect(wakeMaintenance).toHaveBeenCalledOnce();
		expect(repository.cancel).toHaveBeenCalledBefore(wakeMaintenance);
	});

	it.each(['COMPLETING', 'VERIFYING', 'READY'] as const)(
		'preserves the cancel conflict for %s sessions and does not wake maintenance',
		async (state) => {
			const current = session({ state });
			const { service, repository, wakeMaintenance } = harness(current);
			(repository.cancel as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ cancelled: false });

			await expect(service.cancel({ id: 11, role: 'USER' }, current.id))
				.rejects.toMatchObject({ statusCode: 409 });
			expect(wakeMaintenance).not.toHaveBeenCalled();
		},
	);
});
