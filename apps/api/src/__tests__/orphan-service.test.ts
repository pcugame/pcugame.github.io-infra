import { describe, expect, it, vi } from 'vitest';
import { createOrphanService } from '../modules/orphan/service.js';

function createDependencies() {
	const now = new Date('2026-07-21T05:00:00.000Z');
	return {
		now,
		deps: {
			clock: { now: () => now },
			storage: { delete: vi.fn() },
			repository: {
				upsertOrphan: vi.fn(),
				findPendingOrphans: vi.fn(),
				markResolved: vi.fn(),
				markFailed: vi.fn(),
			},
			logger: { info: vi.fn(), error: vi.fn() },
		},
	};
}

describe('orphan object service', () => {
	it('uses one injected timestamp for cutoff, success, and failure updates', async () => {
		const { deps, now } = createDependencies();
		deps.repository.findPendingOrphans.mockResolvedValue([
			{ id: 1, bucket: 'public', storageKey: 'ok.png', attemptCount: 0 },
			{ id: 2, bucket: 'protected', storageKey: 'retry.zip', attemptCount: 3 },
		]);
		deps.storage.delete
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error('storage unavailable'));
		deps.repository.markResolved.mockResolvedValue(undefined);
		deps.repository.markFailed.mockResolvedValue(undefined);
		const service = createOrphanService(deps);

		await expect(service.runOrphanReaper()).resolves.toEqual({ tried: 2, resolved: 1, failed: 1 });
		expect(deps.repository.findPendingOrphans).toHaveBeenCalledWith(
			50,
			new Date('2026-07-21T04:55:00.000Z'),
		);
		expect(deps.repository.markResolved).toHaveBeenCalledWith(1, now);
		expect(deps.repository.markFailed).toHaveBeenCalledWith(2, expect.any(Error), now);
	});

	it('logs but does not fail the caller when persistence of a retry record fails', async () => {
		const { deps } = createDependencies();
		deps.repository.upsertOrphan.mockRejectedValue(new Error('database unavailable'));
		const service = createOrphanService(deps);

		await expect(service.recordOrphan('public', 'lost.png', 'rollback')).resolves.toBeUndefined();
		expect(deps.logger.error).toHaveBeenCalledOnce();
	});
});
