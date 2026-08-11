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
		renewClaim: vi.fn(async () => ({ count: 1 })),
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
	it('uses one injected timestamp for claim, success, and failure updates', async () => {
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
			new Date('2026-07-21T05:02:00.000Z'),
			'claim-token',
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
		deps.storage.listKeys.mockResolvedValue([
			'webgl/7/build/site/index.html',
			'webgl/7/build/site/main.js',
		]);
		deps.repository.claimPendingOrphans.mockResolvedValue([
			orphan(12, 'webgl/7/build/site/', { targetKind: 'PREFIX', attemptCount: 1 }),
		]);
		const service = createOrphanService(deps);

		await expect(service.runOrphanReaper()).resolves.toEqual({ tried: 1, resolved: 1, failed: 0 });
		expect(deps.storage.listKeys).toHaveBeenCalledWith(
			'public',
			'webgl/7/build/site/',
			expect.objectContaining({ requestTimeoutMs: 60_000 }),
		);
		expect(deps.storage.delete).toHaveBeenCalledTimes(2);
		expect(deps.repository.markClaimResolved).toHaveBeenCalledWith(12, 'claim-token', now);
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

	it('aborts storage work and leaves the row retryable when its deletion lease is lost', async () => {
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
			deps.repository.renewClaim.mockResolvedValue({ count: 0 });
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
