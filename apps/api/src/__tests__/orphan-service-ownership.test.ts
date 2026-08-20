import { describe, expect, it, vi } from 'vitest';

import { createOrphanService } from '../modules/orphan/service.js';
import { deferred } from './helpers/deferred.js';
import {
	createOrphanServiceDependencies,
	orphan,
} from './helpers/orphan-service-fixture.js';

describe('orphan service claim renewal integration', () => {
	it('coalesces a successful heartbeat renewal with an overlapping prefix pre-delete renewal', async () => {
		vi.useFakeTimers();
		try {
			const { deps } = createOrphanServiceDependencies();
			deps.repository.claimPendingOrphans.mockResolvedValue([
				orphan(26, 'webgl/26/site/', { targetKind: 'PREFIX' }),
			]);
			const heartbeatRenewal = deferred<{ count: number }>();
			deps.repository.renewActiveClaim
				.mockResolvedValueOnce({ count: 1 })
				.mockImplementationOnce(() => heartbeatRenewal.promise);
			const listEntered = deferred();
			const listReleased = deferred();
			deps.storage.listKeyPage
				.mockImplementationOnce(async () => {
					listEntered.resolve();
					await listReleased.promise;
					return { keys: ['webgl/26/site/index.html'], isTruncated: false };
				})
				.mockResolvedValueOnce({ keys: [], isTruncated: false });
			const service = createOrphanService(deps);

			const running = service.runOrphanReaper();
			await listEntered.promise;
			await vi.advanceTimersByTimeAsync(30_000);
			expect(deps.repository.renewActiveClaim).toHaveBeenCalledTimes(2);

			listReleased.resolve();
			await vi.advanceTimersByTimeAsync(0);
			// The service's destructive boundary waits on the heartbeat flight.
			expect(deps.storage.deleteKeys).not.toHaveBeenCalled();
			expect(deps.repository.renewActiveClaim).toHaveBeenCalledTimes(2);

			heartbeatRenewal.resolve({ count: 1 });
			await expect(running).resolves.toEqual({ tried: 1, resolved: 1, failed: 0 });
			expect(deps.repository.renewActiveClaim).toHaveBeenCalledTimes(2);
			expect(deps.storage.deleteKeys).toHaveBeenCalledOnce();
			expect(deps.repository.markClaimResolved).toHaveBeenCalledOnce();
			expect(deps.repository.markClaimFailed).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it('times out a pending heartbeat and pre-delete renewal flight without issuing DELETE', async () => {
		vi.useFakeTimers();
		const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((delay) => {
			const controller = new AbortController();
			setTimeout(() => {
				controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
			}, delay);
			return controller.signal;
		});
		try {
			const { deps } = createOrphanServiceDependencies();
			deps.repository.claimPendingOrphans.mockResolvedValue([
				orphan(29, 'webgl/29/site/', { targetKind: 'PREFIX' }),
			]);
			const renewalNeverSettles = new Promise<{ count: number }>(() => {});
			deps.repository.renewActiveClaim
				.mockResolvedValueOnce({ count: 1 })
				.mockImplementationOnce(() => renewalNeverSettles);
			const listEntered = deferred();
			const listReleased = deferred();
			deps.storage.listKeyPage.mockImplementationOnce(async () => {
				listEntered.resolve();
				await listReleased.promise;
				return { keys: ['webgl/29/site/index.html'], isTruncated: false };
			});
			const service = createOrphanService(deps);

			const running = service.runOrphanReaper();
			await listEntered.promise;
			await vi.advanceTimersByTimeAsync(30_000);
			expect(deps.repository.renewActiveClaim).toHaveBeenCalledTimes(2);
			listReleased.resolve();
			await vi.advanceTimersByTimeAsync(0);
			expect(deps.storage.deleteKeys).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(60_000);
			await expect(running).resolves.toEqual({ tried: 1, resolved: 0, failed: 1 });
			expect(deps.repository.renewActiveClaim).toHaveBeenCalledTimes(2);
			expect(deps.storage.deleteKeys).not.toHaveBeenCalled();
			expect(deps.repository.markClaimResolved).not.toHaveBeenCalled();
			expect(deps.repository.markClaimFailed).toHaveBeenCalledOnce();
		} finally {
			timeoutSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it('rejects a delayed initial prefix renewal after its independent renewal deadline', async () => {
		vi.useFakeTimers();
		let timeoutSignal: AbortSignal | undefined;
		const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((delay) => {
			const controller = new AbortController();
			timeoutSignal = controller.signal;
			setTimeout(() => {
				controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
			}, delay);
			return controller.signal;
		});
		try {
			const { deps } = createOrphanServiceDependencies();
			deps.repository.claimPendingOrphans.mockResolvedValue([
				orphan(27, 'webgl/27/stale-renewal/', { targetKind: 'PREFIX' }),
			]);
			const renewalEntered = deferred();
			const delayedRenewal = new Promise<{ count: number }>(() => {});
			deps.repository.renewActiveClaim.mockImplementationOnce(() => {
				renewalEntered.resolve();
				return delayedRenewal;
			});
			const service = createOrphanService(deps);

			const running = service.runOrphanReaper();
			await renewalEntered.promise;
			expect(timeoutSpy).toHaveBeenCalledWith(60_000);
			expect(timeoutSignal?.aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(timeoutSignal?.aborted).toBe(true);

			await expect(running).resolves.toEqual({ tried: 1, resolved: 0, failed: 1 });
			expect(deps.repository.renewActiveClaim).toHaveBeenCalledOnce();
			expect(deps.storage.listKeyPage).not.toHaveBeenCalled();
			expect(deps.storage.deleteKeys).not.toHaveBeenCalled();
			expect(deps.storage.delete).not.toHaveBeenCalled();
			expect(deps.repository.markClaimResolved).not.toHaveBeenCalled();
			expect(deps.repository.markClaimFailed).toHaveBeenCalledOnce();
		} finally {
			timeoutSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it('settles promptly on outer abort while the initial renewal remains pending', async () => {
		const controller = new AbortController();
		const { deps } = createOrphanServiceDependencies();
		deps.repository.claimPendingOrphans.mockResolvedValue([
			orphan(30, 'webgl/30/abort-renewal/', { targetKind: 'PREFIX' }),
		]);
		const renewalEntered = deferred();
		const pendingRenewal = deferred<{ count: number }>();
		let repositorySignal: AbortSignal | undefined;
		deps.repository.renewActiveClaim.mockImplementationOnce((_id, _claimToken, _claimLeaseMs, request) => {
			repositorySignal = request?.signal;
			renewalEntered.resolve();
			return pendingRenewal.promise;
		});
		const service = createOrphanService(deps);

		const running = service.runOrphanReaper(controller.signal);
		await renewalEntered.promise;
		expect(repositorySignal?.aborted).toBe(false);
		controller.abort(new Error('shutdown during claim renewal'));
		expect(repositorySignal?.aborted).toBe(true);
		await expect(running).resolves.toEqual({ tried: 1, resolved: 0, failed: 1 });
		// The guard keeps observing the repository promise after the service settles.
		pendingRenewal.reject(new Error('late database failure'));
		await Promise.resolve();
		expect(deps.storage.listKeyPage).not.toHaveBeenCalled();
		expect(deps.storage.deleteKeys).not.toHaveBeenCalled();
		expect(deps.storage.delete).not.toHaveBeenCalled();
		expect(deps.repository.markClaimResolved).not.toHaveBeenCalled();
		expect(deps.repository.markClaimFailed).toHaveBeenCalledOnce();
	});

	it('preserves a DB renewal timeout as an availability error rather than claim loss', async () => {
		const { deps, now } = createOrphanServiceDependencies();
		const databaseTimeout = Object.assign(
			new Error('Raw query failed: canceling statement due to statement timeout'),
			{ code: 'P2010' },
		);
		deps.repository.claimPendingOrphans.mockResolvedValue([
			orphan(32, 'game/database-timeout.bin', { bucket: 'protected' }),
		]);
		deps.repository.renewActiveClaim.mockRejectedValue(databaseTimeout);
		const service = createOrphanService(deps);

		await expect(service.runOrphanReaper()).resolves.toEqual({ tried: 1, resolved: 0, failed: 1 });
		expect(deps.storage.delete).not.toHaveBeenCalled();
		expect(deps.repository.markClaimFailed).toHaveBeenCalledWith(
			32,
			'claim-token',
			databaseTimeout,
			now,
			expect.any(Date),
		);
	});
});

describe('orphan service ownership fences', () => {
	it('fails closed before storage when an expired claim cannot prove continuity', async () => {
		const { deps } = createOrphanServiceDependencies();
		deps.repository.claimPendingOrphans.mockResolvedValue([
			orphan(15, 'game/already-expired.zip', { bucket: 'protected' }),
		]);
		deps.repository.renewActiveClaim.mockResolvedValue({ count: 0 });
		const service = createOrphanService(deps);

		await expect(service.runOrphanReaper()).resolves.toEqual({ tried: 1, resolved: 0, failed: 1 });
		expect(deps.storage.delete).not.toHaveBeenCalled();
		expect(deps.repository.markClaimFailed).toHaveBeenCalledWith(
			15,
			'claim-token',
			expect.objectContaining({ message: 'Orphan deletion claim was lost' }),
			new Date('2026-07-21T05:00:00.000Z'),
			expect.any(Date),
		);
	});

	it('does not report resolution when ownership expires at the terminal mutation', async () => {
		const { deps } = createOrphanServiceDependencies();
		deps.repository.claimPendingOrphans.mockResolvedValue([
			orphan(18, 'game/expires-after-delete.zip', { bucket: 'protected' }),
		]);
		deps.repository.markClaimResolved.mockResolvedValue({ count: 0 });
		deps.repository.markClaimFailed.mockResolvedValue({ count: 0 });
		const service = createOrphanService(deps);

		await expect(service.runOrphanReaper()).resolves.toEqual({ tried: 1, resolved: 0, failed: 1 });
		expect(deps.storage.delete).toHaveBeenCalledOnce();
		expect(deps.logger.error).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: 18,
				action: 'requeue_orphan',
				result: 'failed',
			}),
			'Failed to record orphan reap attempt',
		);
	});

	it('abandons a later batch row instead of using the stale batch snapshot', async () => {
		const { deps } = createOrphanServiceDependencies();
		deps.repository.claimPendingOrphans.mockResolvedValue([
			orphan(16, 'batch/front.bin'),
			orphan(17, 'batch/back.bin'),
		]);
		deps.repository.renewActiveClaim
			.mockResolvedValueOnce({ count: 1 })
			.mockResolvedValueOnce({ count: 0 });
		const service = createOrphanService(deps);

		await expect(service.runOrphanReaper()).resolves.toEqual({ tried: 2, resolved: 1, failed: 1 });
		expect(deps.references.collect).toHaveBeenCalledOnce();
		expect(deps.storage.delete).toHaveBeenCalledOnce();
		expect(deps.storage.delete).toHaveBeenCalledWith(
			'public',
			'batch/front.bin',
			expect.objectContaining({ requestTimeoutMs: 60_000 }),
		);
	});

	it('aborts in-flight storage work and requeues when heartbeat ownership is lost', async () => {
		vi.useFakeTimers();
		try {
			const { deps } = createOrphanServiceDependencies();
			const deleteEntered = deferred();
			deps.storage.delete.mockImplementation((
				_bucket: string,
				_key: string,
				request?: { signal?: AbortSignal },
			) => {
				deleteEntered.resolve();
				return new Promise<void>((_resolve, reject) => {
					request?.signal?.addEventListener('abort', () => {
						reject(request.signal?.reason ?? new Error('aborted'));
					}, { once: true });
				});
			});
			deps.repository.claimPendingOrphans.mockResolvedValue([
				orphan(15, 'game/lease-lost.zip', { bucket: 'protected' }),
			]);
			deps.repository.renewActiveClaim
				.mockResolvedValueOnce({ count: 1 })
				.mockResolvedValueOnce({ count: 0 });
			const service = createOrphanService(deps);

			const running = service.runOrphanReaper();
			await deleteEntered.promise;
			await vi.advanceTimersByTimeAsync(30_000);
			await expect(running).resolves.toEqual({ tried: 1, resolved: 0, failed: 1 });
			expect(deps.repository.markClaimFailed).toHaveBeenCalledWith(
				15,
				'claim-token',
				expect.any(Error),
				new Date('2026-07-21T05:00:00.000Z'),
				expect.any(Date),
			);
		} finally {
			vi.useRealTimers();
		}
	});
});
