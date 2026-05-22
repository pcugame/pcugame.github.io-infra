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
	findExhibitionsByYear: vi.fn(),
	findPublishedProjectsInExhibitions: vi.fn(),
	findPublishedProjectById: vi.fn(),
	findPublishedProjectBySlug: vi.fn(),
	findExhibitionPosterByStorageKey: vi.fn(),
	getPresignedUrl: vi.fn(),
}));

vi.mock('../modules/public/repository.js', () => ({
	findExhibitionsWithPublishedCounts: mocks.findExhibitionsWithPublishedCounts,
	findExhibitionsByYear: mocks.findExhibitionsByYear,
	findPublishedProjectsInExhibitions: mocks.findPublishedProjectsInExhibitions,
	findPublishedProjectById: mocks.findPublishedProjectById,
	findPublishedProjectBySlug: mocks.findPublishedProjectBySlug,
	findExhibitionPosterByStorageKey: mocks.findExhibitionPosterByStorageKey,
}));

vi.mock('../lib/storage.js', () => ({
	getPresignedUrl: mocks.getPresignedUrl,
}));

import { getExhibitionPosterRedirectUrl, getProjectDetail, listProjectsByYear, listYears } from '../modules/public/service.js';

describe('public exhibition years', () => {
	beforeEach(() => {
		mocks.findExhibitionsWithPublishedCounts.mockReset();
		mocks.findExhibitionsByYear.mockReset();
		mocks.findPublishedProjectsInExhibitions.mockReset();
		mocks.findPublishedProjectById.mockReset();
		mocks.findPublishedProjectBySlug.mockReset();
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

	it('returns archived projects in public year listings', async () => {
		mocks.findExhibitionsByYear.mockResolvedValue([{ id: 1, year: 2026, title: 'Show' }]);
		mocks.findPublishedProjectsInExhibitions.mockResolvedValue([
			{
				id: 10,
				slug: 'archived-game',
				title: 'Archived Game',
				summary: '',
				poster: null,
				members: [],
				exhibitionId: 1,
				status: 'ARCHIVED',
			},
		]);

		await expect(listProjectsByYear('2026')).resolves.toMatchObject({
			year: 2026,
			empty: false,
			items: [{ id: 10, slug: 'archived-game', title: 'Archived Game' }],
		});
	});

	it('preserves archived status on public project detail', async () => {
		mocks.findPublishedProjectById.mockResolvedValue({
			id: 10,
			slug: 'archived-game',
			title: 'Archived Game',
			summary: '',
			description: '',
			isIncomplete: false,
			status: 'ARCHIVED',
			exhibition: { year: 2026 },
			members: [],
			assets: [],
			poster: null,
		});

		await expect(getProjectDetail('10')).resolves.toMatchObject({
			id: 10,
			status: 'ARCHIVED',
		});
	});

	it('returns multiple public videos in asset order and keeps video as first item', async () => {
		mocks.findPublishedProjectById.mockResolvedValue({
			id: 10,
			slug: 'multi-video-game',
			title: 'Multi Video Game',
			summary: '',
			description: '',
			isIncomplete: false,
			status: 'PUBLISHED',
			exhibition: { year: 2026 },
			members: [],
			assets: [
				{
					id: 1,
					kind: 'VIDEO',
					storageKey: 'first.mov',
					playbackStorageKey: 'first.mp4',
					mimeType: 'video/quicktime',
					playbackMimeType: 'video/mp4',
					playbackStatus: 'READY',
				},
				{
					id: 2,
					kind: 'VIDEO',
					storageKey: 'second.mp4',
					playbackStorageKey: null,
					mimeType: 'video/mp4',
					playbackMimeType: '',
					playbackStatus: 'READY',
				},
			],
			poster: null,
		});

		const result = await getProjectDetail('10');

		expect(result.video).toBe(result.videos[0]);
		expect(result.videos).toEqual([
			{
				url: 'https://api.example.com/api/assets/protected/first.mp4',
				mimeType: 'video/mp4',
			},
			{
				url: 'https://api.example.com/api/assets/protected/second.mp4',
				mimeType: 'video/mp4',
			},
		]);
	});
});
