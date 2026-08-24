import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAssetsController } from '../modules/assets/controller.js';
import { createAssetsService } from '../modules/assets/service.js';

const mocks = {
	findById: vi.fn(),
	upsertBan: vi.fn(),
	presign: vi.fn(),
	limit: vi.fn(),
	warn: vi.fn(),
};

const service = createAssetsService({
	presignTtlSec: 45,
	presign: mocks.presign,
	wakeDeletionWorker: vi.fn(),
	loadProjectWithAccess: vi.fn(),
	downloadLimiter: { check: mocks.limit },
	logger: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
	repository: {
		findAssetByIdForDownload: mocks.findById,
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
	project?: null;
} = {}) {
	return {
		id: 42,
		projectId: options.project === null ? null : 7,
		kind: options.kind ?? 'GAME',
		status: options.assetStatus ?? 'READY',
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
		expect(mocks.limit).toHaveBeenCalledWith(
			'203.0.113.1',
			'anonymous:203.0.113.1:DOWNLOAD_ORIGINAL:42',
		);
	});

	it('registers only the canonical assetId+variant route', async () => {
		mocks.findById.mockResolvedValue(asset());
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
			expect(bridge.statusCode).toBe(404);
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

	it('fails closed for a missing/non-READY canonical row and never maps playback to original', async () => {
		mocks.findById.mockResolvedValue(asset({
			kind: 'VIDEO',
			representations: [{ role: 'PLAYBACK', bucket: 'private', objectKey: 'pending', state: 'VERIFYING' }],
		}));
		await expect(service.downloadAssetById(42, 'playback', '203.0.113.4', undefined))
			.rejects.toMatchObject({ statusCode: 404 });

		mocks.findById.mockResolvedValue(asset({ kind: 'VIDEO', representations: [] }));
		await expect(service.downloadAssetById(42, 'playback', '203.0.113.4', undefined))
			.rejects.toMatchObject({ statusCode: 404 });
		expect(mocks.presign).not.toHaveBeenCalled();
	});

	it('redirects a READY VIDEO original while its FAILED playback remains unavailable', async () => {
		mocks.findById.mockResolvedValue(asset({
			kind: 'VIDEO',
			representations: [
				{ role: 'ORIGINAL', bucket: 'private', objectKey: 'video/original.mov', state: 'READY' },
				{ role: 'PLAYBACK', bucket: 'private', objectKey: 'video/playback.mp4', state: 'FAILED' },
			],
		}));

		await expect(service.downloadAssetById(42, 'original', '203.0.113.5', undefined))
			.resolves.toMatchObject({ status: 302, location: 'https://garage.test/signed' });
		expect(mocks.presign).toHaveBeenCalledWith(
			'private', 'video/original.mov', { ttlSec: 45 },
		);
		await expect(service.downloadAssetById(42, 'playback', '203.0.113.5', undefined))
			.rejects.toMatchObject({ statusCode: 404 });
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
