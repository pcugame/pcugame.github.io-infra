import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createMultipartRequestHasher } from '../infrastructure/multipart-request-hasher.js';
import { createIdempotencyService } from '../modules/idempotency/service.js';
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
		const now = new Date('2026-08-11T00:00:00.000Z');
		const service = createIdempotencyService({
			repository: {
				claim: vi.fn(),
				renewOwnership,
				markFailed: vi.fn(),
				purgeExpired: vi.fn(),
			},
			clock: { now: () => now },
		});

		await expect(service.renew({ operationId: 'operation', ownerToken: 'owner' }))
			.resolves.toBeUndefined();
		expect(renewOwnership).toHaveBeenNthCalledWith(1, {
			operationId: 'operation',
			ownerToken: 'owner',
			now,
			ownerUntil: new Date('2026-08-11T00:02:00.000Z'),
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
		renewClaim: vi.fn(),
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
