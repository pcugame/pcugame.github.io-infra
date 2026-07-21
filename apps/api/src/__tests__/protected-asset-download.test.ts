import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../shared/errors.js';
import { createAssetsService } from '../modules/assets/service.js';

const mocks = {
	findAssetByStorageKey: vi.fn(),
	findPublicAsset: vi.fn(),
	upsertBannedIp: vi.fn(),
	getPresignedUrl: vi.fn(),
	limiterCheck: vi.fn(),
	loggerError: vi.fn(),
};

const assetsService = createAssetsService({
	publicBucket: 'public-bucket',
	protectedBucket: 'protected-bucket',
	presign: mocks.getPresignedUrl,
	bucketForKind: () => 'bucket',
	deleteOrQueue: vi.fn(),
	loadProjectWithAccess: vi.fn(),
	downloadLimiter: {
		loadBannedIps: vi.fn(),
		check: mocks.limiterCheck,
	},
	logger: { info: vi.fn(), warn: vi.fn(), error: mocks.loggerError },
	repository: {
		findPublicAsset: mocks.findPublicAsset,
		findAssetByStorageKey: mocks.findAssetByStorageKey,
		upsertBannedIp: mocks.upsertBannedIp,
		findAllBannedIps: vi.fn(),
		findAssetByIdWithProject: vi.fn(),
		markAssetDeleting: vi.fn(),
		markAssetDeleted: vi.fn(),
		clearPosterIfMatches: vi.fn(),
	},
});
const { streamProtectedAsset, streamPublicAsset } = assetsService;

function asset(opts: {
	kind: string;
	status?: string;
	creatorId?: number;
	memberIds?: number[];
	title?: string;
}) {
	return {
		kind: opts.kind,
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
		mocks.limiterCheck.mockReturnValue('ok');
	});

	it.each(['GAME', 'VIDEO'])('applies the protected download limiter to %s redirects and persists bans', async (kind) => {
		const key = `${kind.toLowerCase()}.bin`;
		const ip = `203.0.113.${kind === 'GAME' ? '10' : '11'}`;
		mocks.findAssetByStorageKey.mockResolvedValue(asset({ kind }));
		mocks.limiterCheck.mockReturnValueOnce('ok').mockReturnValueOnce('ban');

		const firstResponse = await streamProtectedAsset(key, ip, undefined);

		expect(mocks.limiterCheck).toHaveBeenNthCalledWith(1, ip);
		if (kind === 'GAME') {
			expect(mocks.getPresignedUrl).toHaveBeenCalledWith(
				'protected-bucket',
				key,
				expect.objectContaining({ responseContentDisposition: expect.stringContaining("filename*=UTF-8''") }),
			);
		} else {
			expect(mocks.getPresignedUrl).toHaveBeenCalledWith('protected-bucket', key);
		}
		expect(firstResponse).toEqual({
			status: 302,
			headers: { 'Referrer-Policy': 'no-referrer' },
			location: `https://signed.example/protected-bucket/${key}`,
		});

		await expect(streamProtectedAsset(key, ip, undefined)).rejects.toMatchObject({
			statusCode: 403,
			code: 'FORBIDDEN',
		});

		expect(mocks.limiterCheck).toHaveBeenNthCalledWith(2, ip);
		expect(mocks.upsertBannedIp).toHaveBeenCalledWith(ip, 'Rate limit exceeded (protected asset download)');
	});

	it('uses project and ordered member data for the GAME download filename', async () => {
		mocks.findAssetByStorageKey.mockResolvedValue({
			kind: 'GAME',
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
				responseContentDisposition:
					'attachment; filename="game.zip"; filename*=UTF-8\'\'%EB%B3%84%EB%B9%9B%20%EA%B2%8C%EC%9E%84_%ED%99%8D%EA%B8%B8%EB%8F%99_2026001_%EA%B9%80%EC%B2%A0%EC%88%98_2026002.zip',
			},
		);
	});

	it('falls back to game.zip when the friendly GAME filename exceeds 255 bytes', async () => {
		mocks.findAssetByStorageKey.mockResolvedValue(asset({ kind: 'GAME', title: '가'.repeat(84), memberIds: [1] }));

		await streamProtectedAsset('game.zip', '203.0.113.21', undefined);

		expect(mocks.getPresignedUrl).toHaveBeenCalledWith(
			'protected-bucket',
			'game.zip',
			{
				responseContentDisposition:
					'attachment; filename="game.zip"; filename*=UTF-8\'\'game.zip',
			},
		);
	});

	it.each(['IMAGE', 'POSTER'])('keeps protected %s assets non-public and rate-limits authorized redirects', async (kind) => {
		const key = `${kind.toLowerCase()}.jpg`;
		const ip = `203.0.113.${kind === 'IMAGE' ? '12' : '13'}`;
		mocks.findAssetByStorageKey.mockResolvedValue(asset({ kind, creatorId: 7 }));

		await expect(streamProtectedAsset(key, ip, undefined)).rejects.toMatchObject({
			statusCode: 401,
			code: 'UNAUTHORIZED',
		});
		expect(mocks.limiterCheck).not.toHaveBeenCalled();
		expect(mocks.getPresignedUrl).not.toHaveBeenCalled();

		const response = await streamProtectedAsset(key, ip, { id: 7, role: 'USER' });

		expect(mocks.limiterCheck).toHaveBeenCalledWith(ip);
		expect(response.location).toBe(`https://signed.example/protected-bucket/${key}`);
	});

	it('does not run the limiter before access checks for unauthorized protected assets', async () => {
		mocks.findAssetByStorageKey.mockResolvedValue(asset({ kind: 'VIDEO', status: 'LEGACY', creatorId: 1 }));
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

	it('does not apply the protected download limiter to public asset redirects', async () => {
		mocks.findPublicAsset.mockResolvedValue({ storageKey: 'poster.jpg' });

		const response = await streamPublicAsset('poster.jpg');

		expect(mocks.limiterCheck).not.toHaveBeenCalled();
		expect(mocks.getPresignedUrl).toHaveBeenCalledWith('public-bucket', 'poster.jpg');
		expect(response.location).toBe('https://signed.example/public-bucket/poster.jpg');
	});
});
