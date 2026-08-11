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

	it('logs and propagates persistence failure to the deletion caller', async () => {
		const { deps } = createDependencies();
		const databaseError = new Error('database unavailable');
		deps.repository.upsertOrphan.mockRejectedValue(databaseError);
		const service = createOrphanService(deps);

		await expect(service.recordOrphan('public', 'lost.png', 'rollback'))
			.rejects.toBe(databaseError);
		expect(deps.logger.error).toHaveBeenCalledWith(
			{ err: databaseError, bucket: 'public', storageKey: 'lost.png', reason: 'rollback' },
			'Failed to durably record orphan',
		);
	});

	it('treats deletion of an already missing object as a resolved retry', async () => {
		const { deps, now } = createDependencies();
		deps.repository.findPendingOrphans.mockResolvedValue([
			{ id: 9, bucket: 'public', storageKey: 'already-gone.png', attemptCount: 2 },
		]);
		deps.storage.delete.mockResolvedValue(undefined);
		deps.repository.markResolved.mockResolvedValue(undefined);
		const service = createOrphanService(deps);

		await expect(service.runOrphanReaper()).resolves.toEqual({ tried: 1, resolved: 1, failed: 0 });
		expect(deps.repository.markResolved).toHaveBeenCalledWith(9, now);
		expect(deps.repository.markFailed).not.toHaveBeenCalled();
	});

	it('re-enumerates a durable prefix row on every retry before resolving it', async () => {
		const { deps, now } = createDependencies();
		const listKeys = vi.fn().mockResolvedValue([
			'webgl/7/build/site/index.html',
			'webgl/7/build/site/main.js',
		]);
		deps.storage.delete.mockResolvedValue(undefined);
		deps.repository.findPendingOrphans.mockResolvedValue([{
			id: 12,
			bucket: 'public',
			storageKey: 'webgl/7/build/site/',
			attemptCount: 1,
		}]);
		deps.repository.markResolved.mockResolvedValue(undefined);
		const service = createOrphanService({
			...deps,
			storage: { ...deps.storage, listKeys },
		});

		await expect(service.runOrphanReaper()).resolves.toEqual({ tried: 1, resolved: 1, failed: 0 });
		expect(listKeys).toHaveBeenCalledWith(
			'public',
			'webgl/7/build/site/',
			expect.objectContaining({ requestTimeoutMs: 60_000 }),
		);
		expect(deps.storage.delete).toHaveBeenCalledTimes(2);
		expect(deps.repository.markResolved).toHaveBeenCalledWith(12, now);
	});

	it('cancels a claimed prefix deletion when any overlapping live reference exists', async () => {
		const { deps, now } = createDependencies();
		const claimPendingOrphans = vi.fn().mockResolvedValue([{
			id: 13,
			bucket: 'public',
			storageKey: 'webgl/7/build/site/',
			targetKind: 'PREFIX' as const,
			attemptCount: 0,
		}]);
		const markClaimCancelled = vi.fn().mockResolvedValue({ count: 1 });
		const listKeys = vi.fn();
		const service = createOrphanService({
			...deps,
			storage: { ...deps.storage, listKeys },
			repository: {
				...deps.repository,
				claimPendingOrphans,
				markClaimCancelled,
			},
			references: { isReferenced: vi.fn().mockResolvedValue(true) },
			ids: { next: () => 'claim-token' },
		});

		await expect(service.runOrphanReaper()).resolves.toEqual({ tried: 1, resolved: 1, failed: 0 });
		expect(markClaimCancelled).toHaveBeenCalledWith(
			13,
			'claim-token',
			'live-reference-detected',
			now,
		);
		expect(listKeys).not.toHaveBeenCalled();
		expect(deps.storage.delete).not.toHaveBeenCalled();
	});

	it('aborts storage work and leaves the row retryable when its deletion lease is lost', async () => {
		vi.useFakeTimers();
		try {
			const { deps } = createDependencies();
			let enteredDelete!: () => void;
			const deleteEntered = new Promise<void>((resolve) => { enteredDelete = resolve; });
			const deleteObject = vi.fn((
				_bucket: string,
				_key: string,
				request?: { signal?: AbortSignal },
			) => {
				enteredDelete();
				return new Promise<void>((_resolve, reject) => {
					request?.signal?.addEventListener('abort', () => {
						reject(request.signal?.reason ?? new Error('aborted'));
					}, { once: true });
				});
			});
			const markClaimFailed = vi.fn().mockResolvedValue({ count: 1 });
			const service = createOrphanService({
				...deps,
				storage: { ...deps.storage, delete: deleteObject },
				repository: {
					...deps.repository,
					claimPendingOrphans: vi.fn().mockResolvedValue([{
						id: 14,
						bucket: 'protected',
						storageKey: 'game/lease-lost.zip',
						targetKind: 'EXACT' as const,
						attemptCount: 0,
					}]),
					renewClaim: vi.fn().mockResolvedValue({ count: 0 }),
					markClaimFailed,
				},
				ids: { next: () => 'lease-token' },
			});

			const running = service.runOrphanReaper();
			await deleteEntered;
			await vi.advanceTimersByTimeAsync(30_000);
			await expect(running).resolves.toEqual({ tried: 1, resolved: 0, failed: 1 });
			expect(markClaimFailed).toHaveBeenCalledWith(
				14,
				'lease-token',
				expect.any(Error),
				new Date('2026-07-21T05:00:00.000Z'),
				expect.any(Date),
			);
		} finally {
			vi.useRealTimers();
		}
	});
});
