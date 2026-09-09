import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAssetsController } from '../modules/assets/controller.js';
import { createAssetsService } from '../modules/assets/service.js';

const mocks = {
	findById: vi.fn(),
	findByLegacyKey: vi.fn(),
	recordMetrics: vi.fn(),
	upsertBan: vi.fn(),
	presign: vi.fn(),
	limit: vi.fn(),
	warn: vi.fn(),
};

const service = createAssetsService({
	protectedBucket: 'legacy-protected',
	presignTtlSec: 45,
	presign: mocks.presign,
	clock: { now: () => new Date('2026-08-21T00:00:00.000Z') },
	bucketForKind: () => 'deletion-bucket',
	wakeDeletionWorker: vi.fn(),
	loadProjectWithAccess: vi.fn(),
	downloadLimiter: { check: mocks.limit },
	logger: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
	repository: {
		findAssetByIdForDownload: mocks.findById,
		findAssetsByLegacyStorageKey: mocks.findByLegacyKey,
		recordMigrationObservations: mocks.recordMetrics,
		upsertBannedIp: mocks.upsertBan,
		findAssetByIdWithProject: vi.fn(),
		claimAssetForDeletion: vi.fn(),
		completeAssetDeletion: vi.fn(),
	},
});

function asset(options: {
	kind?: string;
	projectStatus?: string;
	assetStatus?: string;
	creatorId?: number;
	memberIds?: number[];
	representations?: Array<{ role: string; bucket: string; objectKey: string; state: string }>;
	storageKey?: string | null;
	playbackStorageKey?: string | null;
	playbackStatus?: string;
	project?: null;
} = {}) {
	return {
		id: 42,
		projectId: options.project === null ? null : 7,
		kind: options.kind ?? 'GAME',
		status: options.assetStatus ?? 'READY',
		storageKey: options.storageKey === undefined ? 'legacy/original.zip' : options.storageKey,
		playbackStorageKey: options.playbackStorageKey === undefined
			? 'legacy/playback.mp4'
			: options.playbackStorageKey,
		playbackStatus: options.playbackStatus ?? 'READY',
		representations: options.representations ?? [{
			role: 'ORIGINAL', bucket: 'canonical-protected', objectKey: 'assets/42/original/g1', state: 'READY',
		}],
		project: options.project === null ? null : {
			creatorId: options.creatorId ?? 1,
			title: '별빛 게임',
			status: options.projectStatus ?? 'PUBLISHED',
			members: (options.memberIds ?? []).map((userId, index) => ({
				id: index + 1,
				userId,
				name: `학생${index + 1}`,
				studentId: `202600${index + 1}`,
				sortOrder: index,
			})),
		},
	};
}

describe('canonical protected asset capability', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.presign.mockResolvedValue('https://garage.test/signed');
		mocks.limit.mockReturnValue({ status: 'ok' });
		mocks.recordMetrics.mockResolvedValue(undefined);
		mocks.upsertBan.mockResolvedValue(undefined);
	});

	it('prefers canonical ORIGINAL and returns only a short redirect capability', async () => {
		mocks.findById.mockResolvedValue(asset());
		const response = await service.downloadAssetById(42, 'original', '203.0.113.1', undefined);

		expect(mocks.presign).toHaveBeenCalledWith(
			'canonical-protected',
			'assets/42/original/g1',
			expect.objectContaining({ ttlSec: 45, responseContentDisposition: expect.any(String) }),
		);
		expect(response).toEqual({
			status: 302,
			headers: { 'Referrer-Policy': 'no-referrer' },
			location: 'https://garage.test/signed',
		});
		expect(response.body).toBeUndefined();
		expect(mocks.recordMetrics).not.toHaveBeenCalled();
		expect(mocks.limit).toHaveBeenCalledWith(
			'203.0.113.1',
			'anonymous:203.0.113.1:DOWNLOAD_ORIGINAL:42',
		);
	});

	it('registers canonical assetId+variant and legacy bridge routes as redirects', async () => {
		mocks.findById.mockResolvedValue(asset());
		mocks.findByLegacyKey.mockResolvedValue([asset()]);
		const app = Fastify();
		await app.register(createAssetsController({ service }), { prefix: '/api' });
		await app.ready();
		try {
			const canonical = await app.inject({
				method: 'GET', url: '/api/assets/42/download?variant=original',
			});
			expect(canonical.statusCode).toBe(302);
			expect(canonical.headers.location).toBe('https://garage.test/signed');

			const bridge = await app.inject({
				method: 'GET', url: '/api/assets/protected/legacy%2Foriginal.zip',
			});
			expect(bridge.statusCode).toBe(302);
			expect(bridge.headers.location).toBe('https://garage.test/signed');
		} finally {
			await app.close();
		}
	});

	it('resolves VIDEO playback independently from original', async () => {
		mocks.findById.mockResolvedValue(asset({
			kind: 'VIDEO',
			representations: [
				{ role: 'ORIGINAL', bucket: 'private', objectKey: 'video/original', state: 'READY' },
				{ role: 'PLAYBACK', bucket: 'private', objectKey: 'video/playback', state: 'READY' },
			],
		}));
		await service.downloadAssetById(42, 'playback', '203.0.113.2', undefined);
		expect(mocks.presign).toHaveBeenCalledWith('private', 'video/playback', { ttlSec: 45 });
	});

	it.each([
		['original', 'legacy/original.zip', 'ORIGINAL'],
		['playback', 'legacy/playback.mp4', 'PLAYBACK'],
	] as const)('persists telemetry for a %s legacy fallback', async (variant, key, role) => {
		mocks.findById.mockResolvedValue(asset({ kind: 'VIDEO', representations: [] }));
		await service.downloadAssetById(42, variant, '203.0.113.3', undefined);

		expect(mocks.presign).toHaveBeenCalledWith('legacy-protected', key, { ttlSec: 45 });
		expect(mocks.recordMetrics).toHaveBeenCalledWith([{
			name: 'asset_download_legacy_fallback',
			scope: variant,
			observedAt: new Date('2026-08-21T00:00:00.000Z'),
			details: { assetId: 42, role },
		}]);
		expect(mocks.warn).toHaveBeenCalledWith(
			expect.objectContaining({ metric: 'asset_download_legacy_fallback', assetId: 42, variant }),
			'protected_download_compatibility_read',
		);
	});

	it('never falls back past a non-READY canonical row or playback to original', async () => {
		mocks.findById.mockResolvedValue(asset({
			kind: 'VIDEO',
			representations: [{ role: 'PLAYBACK', bucket: 'private', objectKey: 'pending', state: 'VERIFYING' }],
		}));
		await expect(service.downloadAssetById(42, 'playback', '203.0.113.4', undefined))
			.rejects.toMatchObject({ statusCode: 404 });

		mocks.findById.mockResolvedValue(asset({
			kind: 'VIDEO', representations: [], playbackStorageKey: null, playbackStatus: 'READY',
		}));
		await expect(service.downloadAssetById(42, 'playback', '203.0.113.4', undefined))
			.rejects.toMatchObject({ statusCode: 404 });
		expect(mocks.presign).not.toHaveBeenCalled();
	});

	it('keeps the old URL as a separately measured bridge into canonical resolution', async () => {
		mocks.findByLegacyKey.mockResolvedValue([asset()]);
		await service.downloadAssetByLegacyStorageKey('legacy/original.zip', '203.0.113.5', undefined);

		expect(mocks.presign).toHaveBeenCalledWith(
			'canonical-protected',
			'assets/42/original/g1',
			expect.objectContaining({ ttlSec: 45 }),
		);
		expect(mocks.recordMetrics).toHaveBeenCalledWith([{
			name: 'asset_download_legacy_route',
			scope: 'original',
			observedAt: new Date('2026-08-21T00:00:00.000Z'),
			details: { assetId: 42, role: 'ORIGINAL' },
		}]);
	});

	it('fails clearly for missing, duplicate, and ambiguous legacy identity', async () => {
		mocks.findByLegacyKey.mockResolvedValue([]);
		await expect(service.downloadAssetByLegacyStorageKey('missing', '203.0.113.6', undefined))
			.rejects.toMatchObject({ statusCode: 404 });

		mocks.findByLegacyKey.mockResolvedValue([asset(), { ...asset(), id: 43 }]);
		await expect(service.downloadAssetByLegacyStorageKey('legacy/original.zip', '203.0.113.6', undefined))
			.rejects.toMatchObject({ statusCode: 500, code: 'INTERNAL_ERROR' });

		mocks.findByLegacyKey.mockResolvedValue([asset({ storageKey: 'same', playbackStorageKey: 'same' })]);
		await expect(service.downloadAssetByLegacyStorageKey('same', '203.0.113.6', undefined))
			.rejects.toMatchObject({ statusCode: 500, code: 'INTERNAL_ERROR' });
	});

	it('preserves public and admin/creator/member authorization semantics', async () => {
		for (const projectStatus of ['PUBLISHED', 'ARCHIVED']) {
			mocks.findById.mockResolvedValue(asset({ kind: 'VIDEO', projectStatus }));
			await expect(service.downloadAssetById(42, 'original', '203.0.113.7', undefined))
				.resolves.toMatchObject({ status: 302 });
		}

		mocks.findById.mockResolvedValue(asset({ projectStatus: 'PRIVATE', creatorId: 10, memberIds: [11] }));
		await expect(service.downloadAssetById(42, 'original', '203.0.113.7', undefined))
			.rejects.toMatchObject({ statusCode: 401 });
		for (const actor of [
			{ id: 10, role: 'USER' as const },
			{ id: 11, role: 'USER' as const },
			{ id: 99, role: 'ADMIN' as const },
		]) {
			await expect(service.downloadAssetById(42, 'original', '203.0.113.7', actor))
				.resolves.toMatchObject({ status: 302 });
		}
	});

	it('authorizes and checks READY before limiting or signing', async () => {
		mocks.findById.mockResolvedValue(asset({ projectStatus: 'PRIVATE', creatorId: 1, assetStatus: 'VERIFYING' }));
		await expect(service.downloadAssetById(
			42, 'original', '203.0.113.8', { id: 2, role: 'USER' },
		)).rejects.toMatchObject({ statusCode: 403 });
		expect(mocks.limit).not.toHaveBeenCalled();

		mocks.findById.mockResolvedValue(asset({ assetStatus: 'VERIFYING' }));
		await expect(service.downloadAssetById(42, 'original', '203.0.113.8', undefined))
			.rejects.toMatchObject({ statusCode: 404 });
		expect(mocks.limit).not.toHaveBeenCalled();
		expect(mocks.presign).not.toHaveBeenCalled();
	});

	it('throttles a principal but persists a ban only at the IP abuse ceiling', async () => {
		mocks.findById.mockResolvedValue(asset());
		mocks.limit.mockReturnValueOnce({ status: 'rate_limited', retryAfterSec: 9 });
		await expect(service.downloadAssetById(
			42, 'original', '203.0.113.9', { id: 50, role: 'USER' },
		)).rejects.toMatchObject({ statusCode: 429, code: 'RATE_LIMITED', details: { retryAfterSec: 9 } });
		expect(mocks.upsertBan).not.toHaveBeenCalled();

		mocks.limit.mockReturnValueOnce({ status: 'abuse_ceiling' });
		await expect(service.downloadAssetById(
			42, 'original', '203.0.113.9', { id: 50, role: 'USER' },
		)).rejects.toMatchObject({ statusCode: 403 });
		expect(mocks.upsertBan).toHaveBeenCalledWith(
			'203.0.113.9', 'Protected download IP abuse ceiling exceeded',
		);
	});

	it('keeps the Fastify graph free of object-body reads and relays', async () => {
		const graph = (await Promise.all([
			readFile(new URL('../modules/assets/controller.ts', import.meta.url), 'utf8'),
			readFile(new URL('../modules/assets/service.ts', import.meta.url), 'utf8'),
		])).join('\n');
		expect(graph).not.toMatch(/storage\.stream|GetObjectCommand|createReadStream|reply\.send\([^)]*body/);
		expect(graph).toContain('deps.presign');
	});
});
