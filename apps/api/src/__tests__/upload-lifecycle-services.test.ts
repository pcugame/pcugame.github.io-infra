import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createMultipartRequestHasher } from '../infrastructure/multipart-request-hasher.js';
import { createIdempotencyService } from '../modules/idempotency/service.js';
import type { MultipartAbortRepository } from '../modules/multipart-abort/ports.js';
import { createMultipartAbortService } from '../modules/multipart-abort/service.js';
import { createUploadIntentService } from '../modules/upload-intent/service.js';
import type { UploadIntentRepository } from '../modules/upload-intent/ports.js';
import { createUploadTempScavenger } from '../modules/upload-intent/temp-scavenger.js';

describe('multipart request hashing', () => {
	it('is canonical for payload keys and binds file bytes and metadata', async () => {
		const bodies = new Map([
			['/one', Buffer.from('one')],
			['/two', Buffer.from('two')],
		]);
		const hasher = createMultipartRequestHasher({
			createReadStream: (path) => Readable.from([bodies.get(path)!]),
		});
		const files = [{ tmpPath: '/one', fieldname: 'file', filename: 'game.zip' }];
		const left = await hasher.hash({ b: 2, a: { y: 2, x: 1 } }, files);
		const right = await hasher.hash({ a: { x: 1, y: 2 }, b: 2 }, files);
		const changed = await hasher.hash(
			{ a: { x: 1, y: 2 }, b: 2 },
			[{ tmpPath: '/two', fieldname: 'file', filename: 'game.zip' }],
		);
		expect(left).toBe(right);
		expect(changed).not.toBe(left);
	});
});

describe('idempotency operation service', () => {
	it('maps conflict and in-progress claims to stable API codes', async () => {
		const claim = vi.fn()
			.mockResolvedValueOnce({ kind: 'conflict' })
			.mockResolvedValueOnce({ kind: 'in_progress' });
		const service = createIdempotencyService({
			repository: {
				claim,
				renewOwnership: vi.fn(),
				markFailed: vi.fn(),
				purgeExpired: vi.fn(),
			},
			clock: { now: () => new Date('2026-08-11T00:00:00.000Z') },
			ids: { next: vi.fn().mockReturnValueOnce('owner').mockReturnValueOnce('operation')
				.mockReturnValueOnce('owner-2').mockReturnValueOnce('operation-2') },
		});
		await expect(service.claim({ actorId: 1, scope: 'asset', key: 'key', requestHash: 'a' }))
			.rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_CONFLICT' });
		await expect(service.claim({ actorId: 1, scope: 'asset', key: 'key', requestHash: 'a' }))
			.rejects.toMatchObject({ statusCode: 409, code: 'OPERATION_IN_PROGRESS' });
	});

	it('renews the owner lease for two minutes and fails closed after ownership is lost', async () => {
		const renewOwnership = vi.fn()
			.mockResolvedValueOnce({ count: 1 })
			.mockResolvedValueOnce({ count: 0 });
		const service = createIdempotencyService({
			repository: {
				claim: vi.fn(),
				renewOwnership,
				markFailed: vi.fn(),
				purgeExpired: vi.fn(),
			},
			clock: { now: () => new Date('2026-08-11T00:00:00.000Z') },
		});

		await expect(service.renew({ operationId: 'operation', ownerToken: 'owner' }))
			.resolves.toBeUndefined();
		expect(renewOwnership).toHaveBeenNthCalledWith(1, {
			operationId: 'operation',
			ownerToken: 'owner',
			leaseMs: 2 * 60 * 1000,
		});
		await expect(service.renew({ operationId: 'operation', ownerToken: 'stale-owner' }))
			.rejects.toThrow('Idempotency operation lease was lost');
	});
});

function intentRepository(
	intents: Array<{
		id: string;
		bucket: string;
		storageKey: string;
		state: 'PREPARED' | 'UPLOADED' | 'COMMITTED';
		attemptCount: number;
	}>,
) {
	return {
		prepare: vi.fn(),
		markUploaded: vi.fn(),
		isUncommitted: vi.fn(),
		recordAmbiguousError: vi.fn(),
		claimStale: vi.fn().mockResolvedValue(intents),
		renewClaim: vi.fn(async () => ({ count: 1 })),
		markReferenced: vi.fn(),
		markMissing: vi.fn(),
		queueCleanup: vi.fn(),
		markSweepFailed: vi.fn(),
	} satisfies UploadIntentRepository;
}

describe('upload-intent convergence', () => {
	it('queues an unreferenced object and resolves a missing object', async () => {
		const repository = intentRepository([
			{ id: 'present', bucket: 'public', storageKey: 'present.png', state: 'UPLOADED', attemptCount: 0 },
			{ id: 'missing', bucket: 'public', storageKey: 'missing.png', state: 'PREPARED', attemptCount: 0 },
		]);
		const collect = vi.fn(async () => ({
			references: [],
			unsafeBuckets: new Set<string>(),
		}));
		const service = createUploadIntentService({
			repository,
			references: { collect },
			storage: {
				head: vi.fn(async (_bucket, key) => key === 'present.png'
					? { size: 1, contentType: 'image/png' }
					: null),
			},
			clock: { now: () => new Date('2026-08-11T00:00:00.000Z') },
			ids: { next: () => 'claim' },
			logger: { info: vi.fn(), error: vi.fn() },
		});

		await expect(service.sweep()).resolves.toEqual({
			tried: 2,
			referenced: 0,
			queued: 1,
			missing: 1,
		});
		expect(repository.queueCleanup).toHaveBeenCalledWith(
			'present', 'claim', 'public', 'present.png',
		);
		expect(repository.markMissing).toHaveBeenCalledWith('missing', 'claim');
		expect(collect).toHaveBeenCalledOnce();
	});

	it('collects one full reference inventory for a 50-intent batch', async () => {
		const intents = Array.from({ length: 50 }, (_, index) => ({
			id: `intent-${index}`,
			bucket: 'public',
			storageKey: `objects/${index}.png`,
			state: 'UPLOADED' as const,
			attemptCount: 0,
		}));
		const repository = intentRepository(intents);
		const collect = vi.fn(async () => ({
			references: [],
			unsafeBuckets: new Set<string>(),
		}));
		const service = createUploadIntentService({
			repository,
			references: { collect },
			storage: {
				head: vi.fn(async () => ({ size: 1, contentType: 'image/png' })),
			},
			clock: { now: () => new Date('2026-08-11T00:00:00.000Z') },
			ids: { next: () => 'claim' },
			logger: { info: vi.fn(), error: vi.fn() },
		});

		await expect(service.sweep()).resolves.toEqual({
			tried: 50,
			referenced: 0,
			queued: 50,
			missing: 0,
		});
		expect(collect).toHaveBeenCalledOnce();
		expect(repository.queueCleanup).toHaveBeenCalledTimes(50);
	});

	it('aborts in-flight object inspection when an expired claim cannot be renewed', async () => {
		vi.useFakeTimers();
		try {
			const repository = intentRepository([
				{ id: 'expired', bucket: 'public', storageKey: 'expired.png', state: 'UPLOADED', attemptCount: 0 },
			]);
			repository.renewClaim
				.mockResolvedValueOnce({ count: 1 })
				.mockResolvedValueOnce({ count: 0 });
			let inspectionStarted!: () => void;
			const started = new Promise<void>((resolve) => { inspectionStarted = resolve; });
			const head = vi.fn((_bucket, _key, request?: { signal?: AbortSignal }) => {
				inspectionStarted();
				return new Promise<null>((_resolve, reject) => {
					request?.signal?.addEventListener('abort', () => {
						reject(request.signal?.reason ?? new Error('aborted'));
					}, { once: true });
				});
			});
			const service = createUploadIntentService({
				repository,
				references: { collect: vi.fn(async () => ({ references: [], unsafeBuckets: new Set<string>() })) },
				storage: { head },
				clock: { now: () => new Date('2026-08-11T00:00:00.000Z') },
				ids: { next: () => 'expired-token' },
				logger: { info: vi.fn(), error: vi.fn() },
			});

			const running = service.sweep();
			await started;
			await vi.advanceTimersByTimeAsync(30_000);
			await expect(running).resolves.toEqual({
				tried: 1,
				referenced: 0,
				queued: 0,
				missing: 0,
			});
			expect(repository.markSweepFailed).not.toHaveBeenCalled();
			expect(repository.markMissing).not.toHaveBeenCalled();
			expect(repository.queueCleanup).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('multipart-abort convergence', () => {
	it('aborts in-flight storage I/O when a wrong-token heartbeat loses the claim', async () => {
		vi.useFakeTimers();
		try {
			const renew = vi.fn()
				.mockResolvedValueOnce({ count: 1 })
				.mockResolvedValueOnce({ count: 0 });
			const repository = {
				queue: vi.fn(),
				claim: vi.fn(async () => [{
					id: 'abort-task',
					bucket: 'protected',
					storageKey: 'game.zip',
					uploadId: 'upload-id',
					attemptCount: 0,
				}]),
				renew,
				resolve: vi.fn(),
				fail: vi.fn(),
			} satisfies MultipartAbortRepository;
			let abortStarted!: () => void;
			const started = new Promise<void>((resolve) => { abortStarted = resolve; });
			const abortMultipart = vi.fn((_bucket, _key, _uploadId, request?: { signal?: AbortSignal }) => {
				abortStarted();
				return new Promise<void>((_resolve, reject) => {
					request?.signal?.addEventListener('abort', () => {
						reject(request.signal?.reason ?? new Error('aborted'));
					}, { once: true });
				});
			});
			const service = createMultipartAbortService({
				repository,
				storage: { abortMultipart },
				clock: { now: () => new Date('2026-08-11T00:00:00.000Z') },
				ids: { next: () => 'wrong-token' },
				logger: { error: vi.fn() },
			});

			const running = service.run();
			await started;
			await vi.advanceTimersByTimeAsync(30_000);
			await expect(running).resolves.toEqual({ tried: 1, resolved: 0, failed: 1 });
			expect(repository.resolve).not.toHaveBeenCalled();
			expect(repository.fail).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('upload temp scavenger', () => {
	it('removes only aged files in the closed application-owned filename grammar', async () => {
		const remove = vi.fn().mockResolvedValue(undefined);
		const scavenger = createUploadTempScavenger({
			fileSystem: {
				temporaryDirectory: () => '/tmp',
				remove,
				listFiles: vi.fn().mockResolvedValue([
					{
						name: 'pcu-project-upload-11111111-1111-4111-8111-111111111111.webp',
						path: '/tmp/pcu-project-upload-11111111-1111-4111-8111-111111111111.webp',
						lastModified: new Date('2026-08-11T10:00:00.000Z'),
					},
					{
						name: 'project-asset-22222222-2222-4222-8222-222222222222',
						path: '/tmp/project-asset-22222222-2222-4222-8222-222222222222',
						lastModified: new Date('2026-08-11T11:30:00.000Z'),
					},
					{
						name: 'unrelated-user-file',
						path: '/tmp/unrelated-user-file',
						lastModified: new Date('2026-08-10T00:00:00.000Z'),
					},
				]),
			},
			clock: { now: () => new Date('2026-08-11T12:00:00.000Z') },
			logger: { info: vi.fn(), error: vi.fn() },
		});

		await expect(scavenger.sweep()).resolves.toEqual({ scanned: 3, removed: 1, failed: 0 });
		expect(remove).toHaveBeenCalledOnce();
		expect(remove).toHaveBeenCalledWith(
			'/tmp/pcu-project-upload-11111111-1111-4111-8111-111111111111.webp',
		);
	});
});
