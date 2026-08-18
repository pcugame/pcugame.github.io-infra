import { describe, expect, it } from 'vitest';

import { createOrphanService } from '../modules/orphan/service.js';
import {
	createOrphanServiceDependencies,
	orphan,
} from './helpers/orphan-service-fixture.js';

describe('orphan service batch orchestration and result accounting', () => {
	it('uses a DB lease duration while keeping one timestamp for status updates', async () => {
		const { deps, now } = createOrphanServiceDependencies();
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

	it('collects one full reference inventory for a 50-row batch', async () => {
		const { deps } = createOrphanServiceDependencies();
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
});

describe('orphan service durable recording', () => {
	it('logs and propagates persistence failure to the deletion caller', async () => {
		const { deps } = createOrphanServiceDependencies();
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
});

describe('orphan service PREFIX dispatch contract', () => {
	it('re-enumerates a durable prefix target before resolving it', async () => {
		const { deps, now } = createOrphanServiceDependencies();
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
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(deps.repository.renewActiveClaim).toHaveBeenNthCalledWith(
			2,
			12,
			'claim-token',
			120_000,
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(deps.repository.renewActiveClaim).toHaveBeenCalledTimes(2);
		expect(deps.repository.markClaimResolved).toHaveBeenCalledWith(12, 'claim-token', now);
	});

	it('resolves an empty prefix after one attempt-bound renewal without issuing a delete', async () => {
		const { deps } = createOrphanServiceDependencies();
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
});

describe('orphan service live-reference cancellation', () => {
	it('cancels a claimed prefix deletion when an EXACT live reference overlaps it', async () => {
		const { deps, now } = createOrphanServiceDependencies();
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
		const { deps } = createOrphanServiceDependencies();
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

	it('does not report reference cancellation when the claim is no longer active', async () => {
		const { deps } = createOrphanServiceDependencies();
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
});
