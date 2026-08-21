import { describe, expect, it, vi } from 'vitest';
import { createGameUploadValidationWorker } from '../modules/asset-upload/validation-worker.service.js';
import type { AssetUploadRepository } from '../modules/asset-upload/ports.js';

describe('GAME direct validation worker dispatch', () => {
	it('claims only GAME VERIFYING rows, leaving VIDEO and WEBGL leases for their workers', async () => {
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
});
