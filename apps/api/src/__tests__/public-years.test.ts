import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AppError } from '../shared/errors.js';

vi.mock('../config/env.js', () => ({
	env: () => ({
		API_PUBLIC_URL: 'https://api.example.com',
		S3_BUCKET_PUBLIC: 'pcu-public',
		S3_PRESIGN_TTL_SEC: 60,
	}),
}));

const mocks = vi.hoisted(() => ({
	findExhibitionsWithPublishedCounts: vi.fn(),
	findExhibitionPosterByStorageKey: vi.fn(),
	getPresignedUrl: vi.fn(),
}));

vi.mock('../modules/public/repository.js', () => ({
	findExhibitionsWithPublishedCounts: mocks.findExhibitionsWithPublishedCounts,
	findExhibitionPosterByStorageKey: mocks.findExhibitionPosterByStorageKey,
}));

vi.mock('../lib/storage.js', () => ({
	getPresignedUrl: mocks.getPresignedUrl,
}));

import { getExhibitionPosterRedirectUrl, listYears } from '../modules/public/service.js';

describe('public exhibition years', () => {
	beforeEach(() => {
		mocks.findExhibitionsWithPublishedCounts.mockReset();
		mocks.findExhibitionPosterByStorageKey.mockReset();
		mocks.getPresignedUrl.mockReset();
	});

	it('includes an exhibition poster URL when a poster key is present', async () => {
		mocks.findExhibitionsWithPublishedCounts.mockResolvedValue([
			{
				id: 1,
				year: 2026,
				title: '졸업작품 전시회',
				posterStorageKey: 'poster.webp',
				_count: { projects: 7 },
			},
		]);

		await expect(listYears()).resolves.toEqual([
			{
				id: 1,
				year: 2026,
				title: '졸업작품 전시회',
				projectCount: 7,
				posterUrl: 'https://api.example.com/api/public/exhibition-posters/poster.webp',
			},
		]);
	});

	it('only presigns registered exhibition poster keys', async () => {
		mocks.findExhibitionPosterByStorageKey.mockResolvedValue({
			id: 1,
			posterStorageKey: 'poster.webp',
		});
		mocks.getPresignedUrl.mockResolvedValue('https://s3.example.com/poster.webp?sig=1');

		await expect(getExhibitionPosterRedirectUrl('poster.webp')).resolves.toBe(
			'https://s3.example.com/poster.webp?sig=1',
		);
		expect(mocks.getPresignedUrl).toHaveBeenCalledWith('pcu-public', 'poster.webp');
	});

	it('rejects unregistered exhibition poster keys', async () => {
		mocks.findExhibitionPosterByStorageKey.mockResolvedValue(null);

		await expect(getExhibitionPosterRedirectUrl('missing.webp')).rejects.toMatchObject({
			statusCode: 404,
		} satisfies Partial<AppError>);
		expect(mocks.getPresignedUrl).not.toHaveBeenCalled();
	});
});
