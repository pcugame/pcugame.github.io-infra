import type { FastifyReply } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../shared/errors.js';

const mocks = vi.hoisted(() => ({
	findAssetByStorageKey: vi.fn(),
	findPublicAsset: vi.fn(),
	upsertBannedIp: vi.fn(),
	getPresignedUrl: vi.fn(),
	limiterCheck: vi.fn(),
	loggerError: vi.fn(),
}));

vi.mock('../config/env.js', () => ({
	env: () => ({
		S3_BUCKET_PUBLIC: 'public-bucket',
		S3_BUCKET_PROTECTED: 'protected-bucket',
	}),
}));

vi.mock('../lib/logger.js', () => ({
	logger: () => ({
		error: mocks.loggerError,
		info: vi.fn(),
		warn: vi.fn(),
	}),
}));

vi.mock('../lib/storage.js', () => ({
	getPresignedUrl: mocks.getPresignedUrl,
	safeDeleteObject: vi.fn(),
}));

vi.mock('../shared/protected-download-limiter.js', () => ({
	protectedDownloadLimiter: {
		check: mocks.limiterCheck,
		loadBannedIps: vi.fn(),
		removeBan: vi.fn(),
	},
}));

vi.mock('../modules/assets/repository.js', () => ({
	findPublicAsset: mocks.findPublicAsset,
	findAssetByStorageKey: mocks.findAssetByStorageKey,
	upsertBannedIp: mocks.upsertBannedIp,
	findAllBannedIps: vi.fn().mockResolvedValue([]),
	findAssetByIdWithProject: vi.fn(),
	markAssetDeleting: vi.fn(),
	markAssetDeleted: vi.fn(),
	clearPosterIfMatches: vi.fn(),
}));

const { streamProtectedAsset, streamPublicAsset } = await import('../modules/assets/service.js');

type ReplyStub = FastifyReply & {
	header: ReturnType<typeof vi.fn>;
	redirect: ReturnType<typeof vi.fn>;
};

function createReply(): ReplyStub {
	const reply = {
		header: vi.fn(),
		redirect: vi.fn(),
	};
	reply.header.mockReturnValue(reply);
	return reply as unknown as ReplyStub;
}

function asset(opts: {
	kind: string;
	status?: string;
	creatorId?: number;
	memberIds?: number[];
}) {
	return {
		kind: opts.kind,
		project: {
			creatorId: opts.creatorId ?? 1,
			status: opts.status ?? 'PUBLISHED',
			members: (opts.memberIds ?? []).map((userId) => ({ userId })),
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

		const firstReply = createReply();
		await streamProtectedAsset(key, ip, undefined, firstReply);

		expect(mocks.limiterCheck).toHaveBeenNthCalledWith(1, ip);
		expect(mocks.getPresignedUrl).toHaveBeenCalledWith('protected-bucket', key);
		expect(firstReply.header).toHaveBeenCalledWith('Referrer-Policy', 'no-referrer');
		expect(firstReply.redirect).toHaveBeenCalledWith(`https://signed.example/protected-bucket/${key}`, 302);

		const bannedReply = createReply();
		await expect(streamProtectedAsset(key, ip, undefined, bannedReply)).rejects.toMatchObject({
			statusCode: 403,
			code: 'FORBIDDEN',
		});

		expect(mocks.limiterCheck).toHaveBeenNthCalledWith(2, ip);
		expect(mocks.upsertBannedIp).toHaveBeenCalledWith(ip, 'Rate limit exceeded (protected asset download)');
		expect(bannedReply.redirect).not.toHaveBeenCalled();
	});

	it.each(['IMAGE', 'POSTER'])('keeps protected %s assets non-public and rate-limits authorized redirects', async (kind) => {
		const key = `${kind.toLowerCase()}.jpg`;
		const ip = `203.0.113.${kind === 'IMAGE' ? '12' : '13'}`;
		mocks.findAssetByStorageKey.mockResolvedValue(asset({ kind, creatorId: 7 }));

		await expect(streamProtectedAsset(key, ip, undefined, createReply())).rejects.toMatchObject({
			statusCode: 401,
			code: 'UNAUTHORIZED',
		});
		expect(mocks.limiterCheck).not.toHaveBeenCalled();
		expect(mocks.getPresignedUrl).not.toHaveBeenCalled();

		const reply = createReply();
		await streamProtectedAsset(key, ip, { id: 7, role: 'USER' }, reply);

		expect(mocks.limiterCheck).toHaveBeenCalledWith(ip);
		expect(reply.redirect).toHaveBeenCalledWith(`https://signed.example/protected-bucket/${key}`, 302);
	});

	it('does not run the limiter before access checks for unauthorized protected assets', async () => {
		mocks.findAssetByStorageKey.mockResolvedValue(asset({ kind: 'VIDEO', status: 'LEGACY', creatorId: 1 }));
		mocks.limiterCheck.mockImplementation(() => {
			throw new AppError(403, 'banned', 'IP_BANNED');
		});

		await expect(streamProtectedAsset('video.mp4', '203.0.113.14', { id: 9, role: 'USER' }, createReply()))
			.rejects.toMatchObject({
				statusCode: 403,
				code: 'FORBIDDEN',
			});
		expect(mocks.limiterCheck).not.toHaveBeenCalled();
		expect(mocks.getPresignedUrl).not.toHaveBeenCalled();
	});

	it('does not apply the protected download limiter to public asset redirects', async () => {
		mocks.findPublicAsset.mockResolvedValue({ storageKey: 'poster.jpg' });

		const reply = createReply();
		await streamPublicAsset('poster.jpg', reply);

		expect(mocks.limiterCheck).not.toHaveBeenCalled();
		expect(mocks.getPresignedUrl).toHaveBeenCalledWith('public-bucket', 'poster.jpg');
		expect(reply.redirect).toHaveBeenCalledWith('https://signed.example/public-bucket/poster.jpg', 302);
	});
});
