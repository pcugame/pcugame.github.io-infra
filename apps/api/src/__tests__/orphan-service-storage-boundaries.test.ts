import { describe, expect, it, vi } from 'vitest';

import { createOrphanService } from '../modules/orphan/service.js';
import { deferred } from './helpers/deferred.js';
import {
	createOrphanServiceDependencies,
	orphan,
} from './helpers/orphan-service-fixture.js';

describe('orphan service PREFIX storage failure propagation', () => {
	it.each([
		{ operation: 'LIST' as const, expectedRenewals: 1, expectedBulkDeletes: 0 },
		{ operation: 'DELETE' as const, expectedRenewals: 2, expectedBulkDeletes: 1 },
	])('requeues a prefix after a $operation transport failure without starting later work', async ({
		operation,
		expectedRenewals,
		expectedBulkDeletes,
	}) => {
		const { deps } = createOrphanServiceDependencies();
		const transportError = new Error(`${operation.toLowerCase()} transport unavailable`);
		deps.repository.claimPendingOrphans.mockResolvedValue([
			orphan(21, 'webgl/21/failed/', { targetKind: 'PREFIX' }),
		]);
		if (operation === 'LIST') {
			deps.storage.listKeyPage.mockRejectedValue(transportError);
		} else {
			deps.storage.listKeyPage.mockResolvedValue({
				keys: ['webgl/21/failed/index.html'],
				isTruncated: false,
			});
			deps.storage.deleteKeys.mockRejectedValue(transportError);
		}
		const service = createOrphanService(deps);

		await expect(service.runOrphanReaper()).resolves.toEqual({ tried: 1, resolved: 0, failed: 1 });
		expect(deps.storage.listKeyPage).toHaveBeenCalledOnce();
		expect(deps.storage.deleteKeys).toHaveBeenCalledTimes(expectedBulkDeletes);
		expect(deps.storage.delete).not.toHaveBeenCalled();
		expect(deps.repository.renewActiveClaim).toHaveBeenCalledTimes(expectedRenewals);
		expect(deps.repository.markClaimResolved).not.toHaveBeenCalled();
		expect(deps.repository.markClaimFailed).toHaveBeenCalledWith(
			21,
			'claim-token',
			expect.any(Error),
			new Date('2026-07-21T05:00:00.000Z'),
			expect.any(Date),
		);
	});
});

describe('orphan service PREFIX abort boundaries', () => {
	it('does not resolve when an outer abort occurs inside a terminal empty prefix LIST', async () => {
		const controller = new AbortController();
		const { deps } = createOrphanServiceDependencies();
		deps.repository.claimPendingOrphans.mockResolvedValue([
			orphan(22, 'webgl/22/empty/', { targetKind: 'PREFIX' }),
		]);
		deps.storage.listKeyPage.mockImplementation(async (
			_bucket: string,
			_prefix: string,
			_page: { startAfter?: string; maxKeys: number },
			request?: { signal?: AbortSignal },
		) => {
			expect(request?.signal?.aborted).toBe(false);
			controller.abort(new Error('shutdown during empty list'));
			expect(request?.signal?.aborted).toBe(true);
			return { keys: [], isTruncated: false };
		});
		const service = createOrphanService(deps);

		await expect(service.runOrphanReaper(controller.signal)).resolves.toEqual({
			tried: 1,
			resolved: 0,
			failed: 1,
		});
		expect(deps.storage.listKeyPage).toHaveBeenCalledOnce();
		expect(deps.storage.deleteKeys).not.toHaveBeenCalled();
		expect(deps.repository.markClaimResolved).not.toHaveBeenCalled();
		expect(deps.repository.markClaimFailed).toHaveBeenCalledOnce();
	});

	it('does not resolve when an outer abort occurs inside the terminal fresh-head LIST', async () => {
		const controller = new AbortController();
		const { deps } = createOrphanServiceDependencies();
		deps.repository.claimPendingOrphans.mockResolvedValue([
			orphan(23, 'webgl/23/site/', { targetKind: 'PREFIX' }),
		]);
		deps.storage.listKeyPage
			.mockResolvedValueOnce({ keys: ['webgl/23/site/index.html'], isTruncated: false })
			.mockImplementationOnce(async (
				_bucket: string,
				_prefix: string,
				_page: { startAfter?: string; maxKeys: number },
				request?: { signal?: AbortSignal },
			) => {
				controller.abort(new Error('shutdown during fresh-head list'));
				expect(request?.signal?.aborted).toBe(true);
				return { keys: [], isTruncated: false };
			});
		const service = createOrphanService(deps);

		await expect(service.runOrphanReaper(controller.signal)).resolves.toEqual({
			tried: 1,
			resolved: 0,
			failed: 1,
		});
		expect(deps.storage.listKeyPage).toHaveBeenCalledTimes(2);
		expect(deps.storage.deleteKeys).toHaveBeenCalledOnce();
		expect(deps.repository.markClaimResolved).not.toHaveBeenCalled();
		expect(deps.repository.markClaimFailed).toHaveBeenCalledOnce();
	});
});

describe('orphan service PREFIX request deadlines', () => {
	it('does not resolve a terminal prefix success returned after the composed request timeout', async () => {
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
				orphan(24, 'webgl/24/timeout/', { targetKind: 'PREFIX' }),
			]);
			const listEntered = deferred();
			let listSignal: AbortSignal | undefined;
			deps.storage.listKeyPage.mockImplementation((
				_bucket: string,
				_prefix: string,
				_page: { startAfter?: string; maxKeys: number },
				request?: { signal?: AbortSignal },
			) => {
				listSignal = request?.signal;
				listEntered.resolve();
				return new Promise<{ keys: string[]; isTruncated: boolean }>((resolve) => {
					request?.signal?.addEventListener('abort', () => {
						resolve({ keys: [], isTruncated: false });
					}, { once: true });
				});
			});
			const service = createOrphanService(deps);

			const running = service.runOrphanReaper();
			await listEntered.promise;
			expect(listSignal?.aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(60_000);
			await expect(running).resolves.toEqual({ tried: 1, resolved: 0, failed: 1 });
			expect(listSignal?.aborted).toBe(true);
			expect(deps.storage.listKeyPage).toHaveBeenCalledOnce();
			expect(deps.storage.deleteKeys).not.toHaveBeenCalled();
			expect(timeoutSpy).toHaveBeenCalledWith(60_000);
			expect(deps.repository.markClaimResolved).not.toHaveBeenCalled();
			expect(deps.repository.markClaimFailed).toHaveBeenCalledOnce();
		} finally {
			timeoutSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it('does not resolve a bulk delete that reports success after its own request timeout', async () => {
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
				orphan(28, 'webgl/28/timeout/', { targetKind: 'PREFIX' }),
			]);
			deps.storage.listKeyPage.mockResolvedValue({
				keys: ['webgl/28/timeout/index.html'], isTruncated: false,
			});
			const deleteEntered = deferred();
			deps.storage.deleteKeys.mockImplementation((
				_bucket: string,
				keys: readonly string[],
				request?: { signal?: AbortSignal },
			) => {
				deleteEntered.resolve();
				return new Promise((resolve) => {
					request?.signal?.addEventListener('abort', () => {
						resolve({ deleted: [...keys], failures: [] });
					}, { once: true });
				});
			});
			const service = createOrphanService(deps);

			const running = service.runOrphanReaper();
			await deleteEntered.promise;
			await vi.advanceTimersByTimeAsync(60_000);
			await expect(running).resolves.toEqual({ tried: 1, resolved: 0, failed: 1 });
			expect(deps.storage.deleteKeys).toHaveBeenCalledOnce();
			expect(deps.repository.markClaimResolved).not.toHaveBeenCalled();
			expect(deps.repository.markClaimFailed).toHaveBeenCalledOnce();
		} finally {
			timeoutSpy.mockRestore();
			vi.useRealTimers();
		}
	});
});

describe('orphan service EXACT request boundaries', () => {
	it('does not resolve an EXACT delete that reports success after its request is aborted', async () => {
		const controller = new AbortController();
		const { deps } = createOrphanServiceDependencies();
		deps.repository.claimPendingOrphans.mockResolvedValue([
			orphan(25, 'webgl/25/exact.bin'),
		]);
		deps.storage.delete.mockImplementation(async (
			_bucket: string,
			_key: string,
			request?: { signal?: AbortSignal },
		) => {
			controller.abort(new Error('shutdown during exact delete'));
			expect(request?.signal?.aborted).toBe(true);
		});
		const service = createOrphanService(deps);

		await expect(service.runOrphanReaper(controller.signal)).resolves.toEqual({
			tried: 1,
			resolved: 0,
			failed: 1,
		});
		expect(deps.storage.delete).toHaveBeenCalledOnce();
		expect(deps.repository.renewActiveClaim).toHaveBeenCalledOnce();
		expect(deps.repository.markClaimResolved).not.toHaveBeenCalled();
		expect(deps.repository.markClaimFailed).toHaveBeenCalledOnce();
	});

	it('does not resolve an EXACT delete that reports success after its own request timeout', async () => {
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
				orphan(31, 'webgl/31/exact.bin'),
			]);
			const deleteEntered = deferred();
			deps.storage.delete.mockImplementation((
				_bucket: string,
				_key: string,
				request?: { signal?: AbortSignal },
			) => {
				deleteEntered.resolve();
				return new Promise<void>((resolve) => {
					request?.signal?.addEventListener('abort', () => resolve(), { once: true });
				});
			});
			const service = createOrphanService(deps);

			const running = service.runOrphanReaper();
			await deleteEntered.promise;
			await vi.advanceTimersByTimeAsync(60_000);
			await expect(running).resolves.toEqual({ tried: 1, resolved: 0, failed: 1 });
			expect(deps.storage.delete).toHaveBeenCalledOnce();
			expect(deps.repository.markClaimResolved).not.toHaveBeenCalled();
			expect(deps.repository.markClaimFailed).toHaveBeenCalledOnce();
		} finally {
			timeoutSpy.mockRestore();
			vi.useRealTimers();
		}
	});
});
