import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../shared/errors.js';
import { createAssetsService } from '../modules/assets/service.js';

const mocks = {
	findAssetByStorageKey: vi.fn(),
	findAssetByIdForDownload: vi.fn(),
	upsertBannedIp: vi.fn(),
	getPresignedUrl: vi.fn(),
	limiterCheck: vi.fn(),
	loggerError: vi.fn(),
};

const assetsService = createAssetsService({
	presignTtlSec: 45,
	presign: mocks.getPresignedUrl,
	bucketForKind: (kind) => kind === 'GAME' || kind === 'VIDEO' ? 'protected-bucket' : 'public-bucket',
	wakeDeletionWorker: vi.fn(),
	loadProjectWithAccess: vi.fn(),
	downloadLimiter: {
		check: mocks.limiterCheck,
	},
	logger: { info: vi.fn(), error: mocks.loggerError },
	repository: {
		findAssetByStorageKey: mocks.findAssetByStorageKey,
		findAssetByIdForDownload: mocks.findAssetByIdForDownload,
		findAssetByIdWithProject: vi.fn(),
		claimAssetForDeletion: vi.fn(),
		completeAssetDeletion: vi.fn(),
	},
});
const { streamProtectedAsset } = assetsService;
const { downloadAssetById } = assetsService;

function asset(opts: {
	kind: string;
	status?: string;
	creatorId?: number;
	memberIds?: number[];
	title?: string;
}) {
	return {
		id: 42,
		projectId: 7,
		status: 'READY',
		kind: opts.kind,
		storageKey: `${opts.kind.toLowerCase()}.original`,
		playbackStorageKey: opts.kind === 'VIDEO' ? 'video.playback' : null,
		playbackStatus: opts.kind === 'VIDEO' ? 'READY' : 'PENDING',
		project: {
			creatorId: opts.creatorId ?? 1,
			title: opts.title ?? '별빛 게임',
			status: opts.status ?? 'PUBLISHED',
			members: (opts.memberIds ?? []).map((userId, index) => ({
				id: index + 1,
				userId,
				name: `학생${index + 1}`,
				studentId: `202600${index + 1}`,
				sortOrder: index,
			})),
		},
	};
}

describe('protected asset redirects', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getPresignedUrl.mockImplementation((bucket: string, key: string) =>
			Promise.resolve(`https://signed.example/${bucket}/${key}`),
		);
		mocks.upsertBannedIp.mockResolvedValue({});
		mocks.limiterCheck.mockReturnValue({ status: 'ok' });
	});

	it.each(['GAME', 'VIDEO'])('applies a transient limiter to %s redirects without persisting bans', async (kind) => {
		const key = `${kind.toLowerCase()}.bin`;
		const ip = `203.0.113.${kind === 'GAME' ? '10' : '11'}`;
		mocks.findAssetByStorageKey.mockResolvedValue({ ...asset({ kind }), storageKey: key });
		mocks.limiterCheck.mockReturnValueOnce({ status: 'ok' }).mockReturnValueOnce({
			status: 'rate_limited',
			retryAfterSec: 12,
		});

		const firstResponse = await streamProtectedAsset(key, ip, undefined);

		expect(mocks.limiterCheck).toHaveBeenNthCalledWith(
			1,
			ip,
			`anonymous:DOWNLOAD_ORIGINAL:42`,
		);
		if (kind === 'GAME') {
			expect(mocks.getPresignedUrl).toHaveBeenCalledWith(
				'protected-bucket',
				key,
				expect.objectContaining({ responseContentDisposition: expect.stringContaining("filename*=UTF-8''") }),
			);
		} else {
			expect(mocks.getPresignedUrl).toHaveBeenCalledWith('protected-bucket', key, { ttlSec: 45 });
		}
		expect(firstResponse).toEqual({
			status: 302,
			headers: { 'Referrer-Policy': 'no-referrer' },
			location: `https://signed.example/protected-bucket/${key}`,
		});

		await expect(streamProtectedAsset(key, ip, undefined)).rejects.toMatchObject({
			statusCode: 429,
			code: 'RATE_LIMITED',
			details: { retryAfterSec: 12 },
		});

		expect(mocks.upsertBannedIp).not.toHaveBeenCalled();
	});

	it('uses project and ordered member data for the GAME download filename', async () => {
		mocks.findAssetByStorageKey.mockResolvedValue({
			id: 42,
			projectId: 7,
			status: 'READY',
			kind: 'GAME',
			storageKey: 'game.zip',
			playbackStorageKey: null,
			playbackStatus: 'PENDING',
			project: {
				creatorId: 1,
				title: '별빛 게임',
				status: 'PUBLISHED',
				members: [
					{ id: 2, userId: 2, name: '김철수', studentId: '2026002', sortOrder: 1 },
					{ id: 1, userId: 1, name: '홍길동', studentId: '2026001', sortOrder: 0 },
				],
			},
		});

		await streamProtectedAsset('game.zip', '203.0.113.20', undefined);

		expect(mocks.getPresignedUrl).toHaveBeenCalledWith(
			'protected-bucket',
			'game.zip',
			{
				ttlSec: 45,
				responseContentDisposition:
					'attachment; filename="game.zip"; filename*=UTF-8\'\'%EB%B3%84%EB%B9%9B%20%EA%B2%8C%EC%9E%84_%ED%99%8D%EA%B8%B8%EB%8F%99_2026001_%EA%B9%80%EC%B2%A0%EC%88%98_2026002.zip',
			},
		);
	});

	it('falls back to game.zip when the friendly GAME filename exceeds 255 bytes', async () => {
		mocks.findAssetByStorageKey.mockResolvedValue({
			...asset({ kind: 'GAME', title: '가'.repeat(84), memberIds: [1] }),
			storageKey: 'game.zip',
		});

		await streamProtectedAsset('game.zip', '203.0.113.21', undefined);

		expect(mocks.getPresignedUrl).toHaveBeenCalledWith(
			'protected-bucket',
			'game.zip',
			{
				ttlSec: 45,
				responseContentDisposition:
					'attachment; filename="game.zip"; filename*=UTF-8\'\'game.zip',
			},
		);
	});

	it.each(['IMAGE', 'POSTER'])('keeps protected %s assets non-public and rate-limits authorized redirects', async (kind) => {
		const key = `${kind.toLowerCase()}.jpg`;
		const ip = `203.0.113.${kind === 'IMAGE' ? '12' : '13'}`;
		mocks.findAssetByStorageKey.mockResolvedValue({ ...asset({ kind, creatorId: 7 }), storageKey: key });

		await expect(streamProtectedAsset(key, ip, undefined)).rejects.toMatchObject({
			statusCode: 401,
			code: 'UNAUTHORIZED',
		});
		expect(mocks.limiterCheck).not.toHaveBeenCalled();
		expect(mocks.getPresignedUrl).not.toHaveBeenCalled();

		const response = await streamProtectedAsset(key, ip, { id: 7, role: 'USER' });

		expect(mocks.limiterCheck).toHaveBeenCalledWith(ip, '7:DOWNLOAD_ORIGINAL:42');
		expect(response.location).toBe(`https://signed.example/public-bucket/${key}`);
	});

	it('resolves canonical IMAGE downloads to the public object bucket', async () => {
		mocks.findAssetByIdForDownload.mockResolvedValue(asset({ kind: 'IMAGE', creatorId: 7 }));

		const response = await downloadAssetById(
			42,
			'original',
			'203.0.113.29',
			{ id: 7, role: 'USER' },
		);

		expect(response.location).toBe('https://signed.example/public-bucket/image.original');
		expect(mocks.getPresignedUrl).toHaveBeenCalledWith(
			'public-bucket',
			'image.original',
			{ ttlSec: 45 },
		);
	});

	it('resolves canonical assetId variants and uses playback passthrough', async () => {
		mocks.findAssetByIdForDownload.mockResolvedValue(asset({ kind: 'VIDEO' }));

		const playback = await downloadAssetById(42, 'playback', '203.0.113.30', undefined);
		expect(playback.status).toBe(302);
		expect(playback.body).toBeUndefined();
		expect(mocks.getPresignedUrl).toHaveBeenLastCalledWith(
			'protected-bucket',
			'video.playback',
			{ ttlSec: 45 },
		);

		mocks.findAssetByIdForDownload.mockResolvedValue({
			...asset({ kind: 'VIDEO' }),
			playbackStorageKey: null,
		});
		await downloadAssetById(42, 'playback', '203.0.113.31', undefined);
		expect(mocks.getPresignedUrl).toHaveBeenLastCalledWith(
			'protected-bucket',
			'video.original',
			{ ttlSec: 45 },
		);
	});

	it('rejects playback until processing is READY, including original-key passthrough', async () => {
		mocks.findAssetByIdForDownload.mockResolvedValue({
			...asset({ kind: 'VIDEO' }),
			playbackStorageKey: null,
			playbackStatus: 'PROCESSING',
		});

		await expect(downloadAssetById(42, 'playback', '203.0.113.33', undefined)).rejects.toMatchObject({
			statusCode: 404,
		});
		expect(mocks.limiterCheck).not.toHaveBeenCalled();
		expect(mocks.getPresignedUrl).not.toHaveBeenCalled();

		await expect(downloadAssetById(42, 'original', '203.0.113.33', undefined)).resolves.toMatchObject({
			status: 302,
		});
		expect(mocks.getPresignedUrl).toHaveBeenCalledWith(
			'protected-bucket',
			'video.original',
			{ ttlSec: 45 },
		);
	});

	it('does not issue grants for non-READY assets or missing variants', async () => {
		mocks.findAssetByIdForDownload.mockResolvedValue({ ...asset({ kind: 'VIDEO' }), status: 'DELETING' });
		await expect(downloadAssetById(42, 'original', '203.0.113.32', undefined)).rejects.toMatchObject({
			statusCode: 404,
		});
		mocks.findAssetByIdForDownload.mockResolvedValue(asset({ kind: 'GAME' }));
		await expect(downloadAssetById(42, 'playback', '203.0.113.32', undefined)).rejects.toMatchObject({
			statusCode: 404,
		});
		expect(mocks.getPresignedUrl).not.toHaveBeenCalled();
	});

	it('does not run the limiter before access checks for unauthorized protected assets', async () => {
		mocks.findAssetByStorageKey.mockResolvedValue({
			...asset({ kind: 'VIDEO', status: 'LEGACY', creatorId: 1 }),
			storageKey: 'video.mp4',
			playbackStorageKey: null,
		});
		mocks.limiterCheck.mockImplementation(() => {
			throw new AppError(403, 'banned', 'IP_BANNED');
		});

		await expect(streamProtectedAsset('video.mp4', '203.0.113.14', { id: 9, role: 'USER' }))
			.rejects.toMatchObject({
				statusCode: 403,
				code: 'FORBIDDEN',
			});
		expect(mocks.limiterCheck).not.toHaveBeenCalled();
		expect(mocks.getPresignedUrl).not.toHaveBeenCalled();
	});

});
