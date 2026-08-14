import { describe, expect, it, vi } from 'vitest';

import { createOrphanService } from '../modules/orphan/service.js';
import type { ObjectReferenceInventory } from '../modules/orphan/reference-resolver.js';

interface ClaimedOrphan {
	id: number;
	bucket: string;
	storageKey: string;
	targetKind: 'EXACT' | 'PREFIX';
	attemptCount: number;
}

function createDependencies() {
	const now = new Date('2026-07-21T05:00:00.000Z');
	const repository = {
		upsertOrphan: vi.fn(async () => undefined),
		claimPendingOrphans: vi.fn(async (): Promise<ClaimedOrphan[]> => []),
		markClaimResolved: vi.fn(async () => ({ count: 1 })),
		renewActiveClaim: vi.fn(async () => ({ count: 1 })),
		markClaimCancelled: vi.fn(async () => ({ count: 1 })),
		markClaimFailed: vi.fn(async () => ({ count: 1 })),
	};
	return {
		now,
		deps: {
			clock: { now: () => now },
			storage: {
				delete: vi.fn(async (
					_bucket: string,
					_key: string,
					_request?: { signal?: AbortSignal; requestTimeoutMs?: number },
				): Promise<void> => undefined),
				listKeys: vi.fn(async (
					_bucket: string,
					_prefix: string,
					_request?: { signal?: AbortSignal; requestTimeoutMs?: number },
				): Promise<string[]> => []),
				listKeyPage: vi.fn(async (
					_bucket: string,
					_prefix: string,
					_page: { startAfter?: string; maxKeys: number },
					_request?: { signal?: AbortSignal; requestTimeoutMs?: number },
				): Promise<{ keys: string[]; isTruncated: boolean }> => ({
					keys: [], isTruncated: false,
				})),
				deleteKeys: vi.fn(async (_bucket: string, keys: readonly string[]) => ({
					deleted: [...keys], failures: [],
				})),
			},
			repository,
			references: {
				collect: vi.fn(async (): Promise<ObjectReferenceInventory> => ({
					references: [],
					unsafeBuckets: new Set<string>(),
				})),
			},
			ids: { next: () => 'claim-token' },
			logger: { info: vi.fn(), error: vi.fn() },
		},
	};
}

function orphan(
	id: number,
	storageKey: string,
	overrides: Partial<{
		bucket: string;
		targetKind: 'EXACT' | 'PREFIX';
		attemptCount: number;
	}> = {},
) {
	return {
		id,
		bucket: overrides.bucket ?? 'public',
		storageKey,
		targetKind: overrides.targetKind ?? 'EXACT',
		attemptCount: overrides.attemptCount ?? 0,
	};
}

describe('orphan object service', () => {
	it('uses a DB lease duration while keeping one timestamp for status updates', async () => {
		const { deps, now } = createDependencies();
		deps.repository.claimPendingOrphans.mockResolvedValue([
			orphan(1, 'ok.png'),
			orphan(2, 'retry.zip', { bucket: 'protected', attemptCount: 3 }),
		]);
		deps.storage.delete
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error('storage unavailable'));
		const service = createOrphanService(deps);

		await expect(service.runOrphanReaper()).resolves.toEqual({ tried: 2, resolved: 1, failed: 1 });
		expect(deps.repository.claimPendingOrphans).toHaveBeenCalledWith(
			50,
			now,
			'claim-token',
			120_000,
		);
		expect(deps.repository.markClaimResolved).toHaveBeenCalledWith(1, 'claim-token', now);
		expect(deps.repository.markClaimFailed).toHaveBeenCalledWith(
			2,
			'claim-token',
			expect.any(Error),
			now,
			expect.any(Date),
		);
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

	it('collects one full reference inventory for a 50-row batch', async () => {
		const { deps } = createDependencies();
		deps.repository.claimPendingOrphans.mockResolvedValue(
			Array.from({ length: 50 }, (_, index) => orphan(index + 1, `objects/${index}.bin`)),
		);
		const service = createOrphanService(deps);

		await expect(service.runOrphanReaper()).resolves.toEqual({
			tried: 50,
			resolved: 50,
			failed: 0,
		});
		expect(deps.references.collect).toHaveBeenCalledOnce();
		expect(deps.storage.delete).toHaveBeenCalledTimes(50);
	});

	it('re-enumerates a durable prefix target before resolving it', async () => {
		const { deps, now } = createDependencies();
		deps.storage.listKeyPage
			.mockResolvedValueOnce({
				keys: ['webgl/7/build/site/index.html', 'webgl/7/build/site/main.js'],
				isTruncated: false,
			})
			.mockResolvedValueOnce({ keys: [], isTruncated: false });
		deps.repository.claimPendingOrphans.mockResolvedValue([
			orphan(12, 'webgl/7/build/site/', { targetKind: 'PREFIX', attemptCount: 1 }),
		]);
		const service = createOrphanService(deps);

		await expect(service.runOrphanReaper()).resolves.toEqual({ tried: 1, resolved: 1, failed: 0 });
		expect(deps.storage.listKeyPage).toHaveBeenCalledWith(
			'public',
			'webgl/7/build/site/',
			{ maxKeys: 1000 },
			expect.objectContaining({ requestTimeoutMs: 60_000 }),
		);
		expect(deps.storage.deleteKeys).toHaveBeenCalledWith(
			'public',
			['webgl/7/build/site/index.html', 'webgl/7/build/site/main.js'],
			expect.objectContaining({ requestTimeoutMs: 60_000 }),
		);
		expect(deps.repository.renewActiveClaim).toHaveBeenNthCalledWith(
			1,
			12,
			'claim-token',
			120_000,
		);
		expect(deps.repository.renewActiveClaim).toHaveBeenNthCalledWith(
			2,
			12,
			'claim-token',
			120_000,
		);
		expect(deps.repository.renewActiveClaim).toHaveBeenCalledTimes(2);
		expect(deps.repository.markClaimResolved).toHaveBeenCalledWith(12, 'claim-token', now);
	});

	it('resolves an empty prefix after one attempt-bound renewal without issuing a delete', async () => {
		const { deps } = createDependencies();
		deps.repository.claimPendingOrphans.mockResolvedValue([
			orphan(20, 'webgl/20/empty/', { targetKind: 'PREFIX' }),
		]);
		const service = createOrphanService(deps);

		await expect(service.runOrphanReaper()).resolves.toEqual({ tried: 1, resolved: 1, failed: 0 });
		expect(deps.storage.listKeyPage).toHaveBeenCalledOnce();
		expect(deps.storage.deleteKeys).not.toHaveBeenCalled();
		expect(deps.storage.delete).not.toHaveBeenCalled();
		expect(deps.repository.renewActiveClaim).toHaveBeenCalledTimes(1);
		expect(deps.repository.markClaimResolved).toHaveBeenCalledOnce();
	});

	it('does not resolve when an outer abort occurs inside a terminal empty prefix LIST', async () => {
		const controller = new AbortController();
		const { deps } = createDependencies();
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

		await expect(service.runOrphanReaper(controller.signal)).resolves.toEqual({ tried: 1, resolved: 0, failed: 1 });
		expect(deps.storage.listKeyPage).toHaveBeenCalledOnce();
		expect(deps.storage.deleteKeys).not.toHaveBeenCalled();
		expect(deps.repository.markClaimResolved).not.toHaveBeenCalled();
		expect(deps.repository.markClaimFailed).toHaveBeenCalledOnce();
	});

	it('does not resolve when an outer abort occurs inside the terminal fresh-head LIST', async () => {
		const controller = new AbortController();
		const { deps } = createDependencies();
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

		await expect(service.runOrphanReaper(controller.signal)).resolves.toEqual({ tried: 1, resolved: 0, failed: 1 });
		expect(deps.storage.listKeyPage).toHaveBeenCalledTimes(2);
		expect(deps.storage.deleteKeys).toHaveBeenCalledOnce();
		expect(deps.repository.markClaimResolved).not.toHaveBeenCalled();
		expect(deps.repository.markClaimFailed).toHaveBeenCalledOnce();
	});

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
			const { deps } = createDependencies();
			deps.repository.claimPendingOrphans.mockResolvedValue([
				orphan(24, 'webgl/24/timeout/', { targetKind: 'PREFIX' }),
			]);
			let enteredList!: () => void;
			const listEntered = new Promise<void>((resolve) => { enteredList = resolve; });
			let listSignal: AbortSignal | undefined;
			deps.storage.listKeyPage.mockImplementation((
				_bucket: string,
				_prefix: string,
				_page: { startAfter?: string; maxKeys: number },
				request?: { signal?: AbortSignal },
			) => {
				listSignal = request?.signal;
				enteredList();
				return new Promise<{ keys: string[]; isTruncated: boolean }>((resolve) => {
					request?.signal?.addEventListener('abort', () => {
						resolve({ keys: [], isTruncated: false });
					}, { once: true });
				});
			});
			const service = createOrphanService(deps);

			const running = service.runOrphanReaper();
			await listEntered;
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

	it('coalesces a successful heartbeat renewal with an overlapping prefix pre-delete renewal', async () => {
		vi.useFakeTimers();
		try {
			const { deps } = createDependencies();
			deps.repository.claimPendingOrphans.mockResolvedValue([
				orphan(26, 'webgl/26/site/', { targetKind: 'PREFIX' }),
			]);
			let resolveHeartbeatRenewal!: (value: { count: number }) => void;
			const heartbeatRenewal = new Promise<{ count: number }>((resolve) => {
				resolveHeartbeatRenewal = resolve;
			});
			deps.repository.renewActiveClaim
				.mockResolvedValueOnce({ count: 1 })
				.mockImplementationOnce(() => heartbeatRenewal);
			let enteredList!: () => void;
			const listEntered = new Promise<void>((resolve) => { enteredList = resolve; });
			let releaseList!: () => void;
			const listReleased = new Promise<void>((resolve) => { releaseList = resolve; });
			deps.storage.listKeyPage
				.mockImplementationOnce(async () => {
					enteredList();
					await listReleased;
					return { keys: ['webgl/26/site/index.html'], isTruncated: false };
				})
				.mockResolvedValueOnce({ keys: [], isTruncated: false });
			const service = createOrphanService(deps);

			const running = service.runOrphanReaper();
			await listEntered;
			await vi.advanceTimersByTimeAsync(30_000);
			expect(deps.repository.renewActiveClaim).toHaveBeenCalledTimes(2);

			releaseList();
			await vi.advanceTimersByTimeAsync(0);
			// beforeDelete is waiting on the heartbeat's still-pending renewalFlight.
			expect(deps.storage.deleteKeys).not.toHaveBeenCalled();
			expect(deps.repository.renewActiveClaim).toHaveBeenCalledTimes(2);

			resolveHeartbeatRenewal({ count: 1 });
			await expect(running).resolves.toEqual({ tried: 1, resolved: 1, failed: 0 });
			expect(deps.repository.renewActiveClaim).toHaveBeenCalledTimes(2);
			expect(deps.storage.deleteKeys).toHaveBeenCalledOnce();
			expect(deps.repository.markClaimResolved).toHaveBeenCalledOnce();
			expect(deps.repository.markClaimFailed).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it('rejects a delayed initial prefix renewal after the bounded attempt signal times out', async () => {
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
			const { deps } = createDependencies();
			deps.repository.claimPendingOrphans.mockResolvedValue([
				orphan(27, 'webgl/27/stale-renewal/', { targetKind: 'PREFIX' }),
			]);
			let enteredRenewal!: () => void;
			const renewalEntered = new Promise<void>((resolve) => { enteredRenewal = resolve; });
			let resolveRenewal!: (value: { count: number }) => void;
			const delayedRenewal = new Promise<{ count: number }>((resolve) => {
				resolveRenewal = resolve;
			});
			deps.repository.renewActiveClaim.mockImplementationOnce(() => {
				enteredRenewal();
				return delayedRenewal;
			});
			const service = createOrphanService(deps);

			const running = service.runOrphanReaper();
			await renewalEntered;
			expect(timeoutSpy).toHaveBeenCalledWith(60_000);
			expect(timeoutSignal?.aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(timeoutSignal?.aborted).toBe(true);

			resolveRenewal({ count: 1 });
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

	it('does not resolve an EXACT delete that reports success after its request is aborted', async () => {
		const controller = new AbortController();
		const { deps } = createDependencies();
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

		await expect(service.runOrphanReaper(controller.signal)).resolves.toEqual({ tried: 1, resolved: 0, failed: 1 });
		expect(deps.storage.delete).toHaveBeenCalledOnce();
		expect(deps.repository.renewActiveClaim).toHaveBeenCalledOnce();
		expect(deps.repository.markClaimResolved).not.toHaveBeenCalled();
		expect(deps.repository.markClaimFailed).toHaveBeenCalledOnce();
	});

	it.each([
		{ operation: 'LIST' as const, expectedRenewals: 1, expectedBulkDeletes: 0 },
		{ operation: 'DELETE' as const, expectedRenewals: 2, expectedBulkDeletes: 1 },
	])('requeues a prefix after a $operation transport failure without starting later work', async ({
		operation,
		expectedRenewals,
		expectedBulkDeletes,
	}) => {
		const { deps } = createDependencies();
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

	it('cancels a claimed prefix deletion when an EXACT live reference overlaps it', async () => {
		const { deps, now } = createDependencies();
		deps.repository.claimPendingOrphans.mockResolvedValue([
			orphan(13, 'webgl/7/build/site/', { targetKind: 'PREFIX' }),
		]);
		deps.references.collect.mockResolvedValue({
			references: [{
				bucket: 'public',
				targetKind: 'EXACT',
				key: 'webgl/7/build/site/index.html',
				source: 'project:7:webgl-site',
			}],
			unsafeBuckets: new Set<string>(),
		});
		const service = createOrphanService(deps);

		await expect(service.runOrphanReaper()).resolves.toEqual({ tried: 1, resolved: 1, failed: 0 });
		expect(deps.repository.markClaimCancelled).toHaveBeenCalledWith(
			13,
			'claim-token',
			'live-reference-detected',
			now,
		);
		expect(deps.storage.listKeys).not.toHaveBeenCalled();
		expect(deps.storage.delete).not.toHaveBeenCalled();
	});

	it('fails closed for every deletion in a bucket with a malformed WebGL pointer', async () => {
		const { deps } = createDependencies();
		deps.repository.claimPendingOrphans.mockResolvedValue([orphan(14, 'unrelated.png')]);
		deps.references.collect.mockResolvedValue({
			references: [],
			unsafeBuckets: new Set(['public']),
		});
		const service = createOrphanService(deps);

		await expect(service.runOrphanReaper()).resolves.toEqual({ tried: 1, resolved: 1, failed: 0 });
		expect(deps.repository.markClaimCancelled).toHaveBeenCalledOnce();
		expect(deps.storage.delete).not.toHaveBeenCalled();
	});

	it('fails closed before storage when an expired claim cannot prove continuity', async () => {
		const { deps } = createDependencies();
		deps.repository.claimPendingOrphans.mockResolvedValue([
			orphan(15, 'game/already-expired.zip', { bucket: 'protected' }),
		]);
		deps.repository.renewActiveClaim.mockResolvedValue({ count: 0 });
		const service = createOrphanService(deps);

		await expect(service.runOrphanReaper()).resolves.toEqual({
			tried: 1,
			resolved: 0,
			failed: 1,
		});
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
		const { deps } = createDependencies();
		deps.repository.claimPendingOrphans.mockResolvedValue([
			orphan(18, 'game/expires-after-delete.zip', { bucket: 'protected' }),
		]);
		deps.repository.markClaimResolved.mockResolvedValue({ count: 0 });
		deps.repository.markClaimFailed.mockResolvedValue({ count: 0 });
		const service = createOrphanService(deps);

		await expect(service.runOrphanReaper()).resolves.toEqual({
			tried: 1,
			resolved: 0,
			failed: 1,
		});
		expect(deps.storage.delete).toHaveBeenCalledOnce();
		expect(deps.logger.error).toHaveBeenCalledWith(
			expect.objectContaining({ orphanId: 18 }),
			'Failed to record orphan reap attempt',
		);
	});

	it('does not report reference cancellation when the claim is no longer active', async () => {
		const { deps } = createDependencies();
		deps.repository.claimPendingOrphans.mockResolvedValue([orphan(19, 'still-live.png')]);
		deps.references.collect.mockResolvedValue({
			references: [{
				bucket: 'public',
				targetKind: 'EXACT',
				key: 'still-live.png',
				source: 'asset:19',
			}],
			unsafeBuckets: new Set<string>(),
		});
		deps.repository.markClaimCancelled.mockResolvedValue({ count: 0 });
		deps.repository.markClaimFailed.mockResolvedValue({ count: 0 });
		const service = createOrphanService(deps);

		await expect(service.runOrphanReaper()).resolves.toEqual({
			tried: 1,
			resolved: 0,
			failed: 1,
		});
		expect(deps.storage.delete).not.toHaveBeenCalled();
	});

	it('abandons a later batch row instead of using the stale batch snapshot', async () => {
		const { deps } = createDependencies();
		deps.repository.claimPendingOrphans.mockResolvedValue([
			orphan(16, 'batch/front.bin'),
			orphan(17, 'batch/back.bin'),
		]);
		deps.repository.renewActiveClaim
			.mockResolvedValueOnce({ count: 1 })
			.mockResolvedValueOnce({ count: 0 });
		const service = createOrphanService(deps);

		await expect(service.runOrphanReaper()).resolves.toEqual({
			tried: 2,
			resolved: 1,
			failed: 1,
		});
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
			const { deps } = createDependencies();
			let enteredDelete!: () => void;
			const deleteEntered = new Promise<void>((resolve) => { enteredDelete = resolve; });
			deps.storage.delete.mockImplementation((
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
			deps.repository.claimPendingOrphans.mockResolvedValue([
				orphan(15, 'game/lease-lost.zip', { bucket: 'protected' }),
			]);
			deps.repository.renewActiveClaim
				.mockResolvedValueOnce({ count: 1 })
				.mockResolvedValueOnce({ count: 0 });
			const service = createOrphanService(deps);

			const running = service.runOrphanReaper();
			await deleteEntered;
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
