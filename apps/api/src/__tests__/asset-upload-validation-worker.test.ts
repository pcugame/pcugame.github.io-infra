import { describe, expect, it, vi } from 'vitest';
import { createGameUploadValidationWorker } from '../modules/asset-upload/validation-worker.service.js';
import type { AssetUploadRepository } from '../modules/asset-upload/ports.js';
import { WorkerSourceObjectMissingError } from '../modules/upload-lifecycle/worker-errors.js';

describe('GAME direct validation worker dispatch', () => {
	it('claims GAME and material VERIFYING rows, leaving media leases for their workers', async () => {
		const repository = {
			claimVerifying: vi.fn(async () => []), renewValidation: vi.fn(),
		} as unknown as AssetUploadRepository;
		const worker = createGameUploadValidationWorker({
			repository,
			storage: { stream: vi.fn() },
			ids: { next: () => 'game-validation-claim' }, tempRoot: '/tmp', tempDiskBudgetBytes: 1024,
			logger: { error: vi.fn() }, wakeDeletionWorker: vi.fn(),
		});
		await expect(worker.runPass()).resolves.toEqual({ claimed: 0, ready: 0, rejected: 0, retried: 0 });
		expect(repository.claimVerifying).toHaveBeenCalledWith('GAME', 8, 'game-validation-claim', 120_000);
	});

	it('terminalizes an authoritative GAME source 404 and releases the validation lease', async () => {
		const session = {
			id: 'game-missing', projectId: 7, exhibitionId: null, userId: 9,
			kind: 'GAME', state: 'VERIFYING', originalName: 'missing.zip', declaredMimeType: 'application/zip',
			totalBytes: 10n, partSizeBytes: 10, totalParts: 1, bucket: 'protected',
			objectKey: 'protected/uploads/game-missing/1/source', uploadId: null, generation: 1,
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'a'.repeat(64),
			sourceIdentityBlockSizeBytes: 1_048_576, sourceIdentityBlockManifest: '',
			completionLeaseToken: null, completionLeaseUntil: null, completionResult: null,
			validationLeaseToken: 'claim', validationLeaseUntil: new Date(Date.now() + 60_000),
			validationAttemptCount: 1, expectedTargetAssetId: null, expectedTargetAssetUpdatedAt: null,
			resultAssetId: null, resultRepresentationId: null, expiresAt: new Date(Date.now() + 60_000),
		};
		const repository = {
			claimVerifying: vi.fn(async (kind) => kind === 'GAME' ? [session] : []), renewValidation: vi.fn(async () => true),
			markRejected: vi.fn(async () => true),
		} as unknown as AssetUploadRepository;
		const worker = createGameUploadValidationWorker({
			repository,
			storage: { stream: vi.fn(async () => {
				throw new WorkerSourceObjectMissingError('Completed direct GAME source object does not exist');
			}) },
			ids: { next: () => 'claim' }, tempRoot: '/tmp', tempDiskBudgetBytes: 1024,
			logger: { error: vi.fn() }, wakeDeletionWorker: vi.fn(),
		});
		await expect(worker.runPass()).resolves.toEqual({ claimed: 1, ready: 0, rejected: 1, retried: 0 });
		expect(repository.markRejected).toHaveBeenCalledWith(
			'game-missing', 1, 'claim', expect.stringContaining('does not exist'),
		);
	});
});
