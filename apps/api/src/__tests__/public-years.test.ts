import { describe, expect, it, vi, beforeEach } from 'vitest';
const mocks = vi.hoisted(() => ({
	findExhibitionsWithPublishedCounts: vi.fn(),
	findExhibitionsByYear: vi.fn(),
	findExhibitionById: vi.fn(),
	findPublishedProjectsInExhibitions: vi.fn(),
	findPublishedProjectById: vi.fn(),
	findPublishedProjectBySlug: vi.fn(),
}));

import { getProjectDetail, listProjectsByYear, listYears } from '../modules/public/service.js';

const dependencies = {
	apiPublicUrl: 'https://api.example.com',
	repository: {
		findExhibitionsWithPublishedCounts: mocks.findExhibitionsWithPublishedCounts,
		findExhibitionsByYear: mocks.findExhibitionsByYear,
		findExhibitionById: mocks.findExhibitionById,
		findPublishedProjectsInExhibitions: mocks.findPublishedProjectsInExhibitions,
		findPublishedProjectById: mocks.findPublishedProjectById,
		findPublishedProjectBySlug: mocks.findPublishedProjectBySlug,
	},
};

describe('public exhibition years', () => {
	beforeEach(() => {
		mocks.findExhibitionsWithPublishedCounts.mockReset();
		mocks.findExhibitionsByYear.mockReset();
		mocks.findExhibitionById.mockReset();
		mocks.findPublishedProjectsInExhibitions.mockReset();
		mocks.findPublishedProjectById.mockReset();
		mocks.findPublishedProjectBySlug.mockReset();
	});

	it('includes an exhibition responsive image when a poster key is present', async () => {
		mocks.findExhibitionsWithPublishedCounts.mockResolvedValue([
			{
				id: 1,
				year: 2026,
				title: '졸업작품 전시회',
				posterStorageKey: 'poster.webp',
				posterWidth: 1200,
				posterHeight: 800,
				posterCard480Height: 320,
				posterDisplay960Height: null,
				_count: { projects: 7 },
			},
		]);

		await expect(listYears(dependencies)).resolves.toEqual([
			{
				id: 1,
				year: 2026,
				title: '졸업작품 전시회',
				projectCount: 7,
				poster: {
					original: {
						url: 'https://api.example.com/api/public/images/poster.webp',
						width: 1200,
						height: 800,
					},
					renditions: [{
						profile: 'CARD_480',
						url: 'https://api.example.com/api/public/images/poster.webp%2F__pcu_image_rendition__%2Fv1%2Fcard-480.webp',
						width: 480,
						height: 320,
					}],
				},
			},
		]);
	});

	it('keeps legacy exhibition posters usable without metadata or renditions', async () => {
		mocks.findExhibitionsWithPublishedCounts.mockResolvedValue([{
			id: 1,
			year: 2025,
			title: '',
			posterStorageKey: 'legacy.webp',
			_count: { projects: 0 },
		}]);

		await expect(listYears(dependencies)).resolves.toMatchObject([{
			poster: {
				original: { url: 'https://api.example.com/api/public/images/legacy.webp' },
				renditions: [],
			},
		}]);
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

		await expect(listProjectsByYear(dependencies, '2026')).resolves.toMatchObject({
			year: 2026,
			empty: false,
			items: [{ id: 10, slug: 'archived-game', title: 'Archived Game' }],
		});
	});

	it('omits a private project poster from public year listings', async () => {
		mocks.findExhibitionsByYear.mockResolvedValue([{ id: 1, year: 2026, title: 'Show' }]);
		mocks.findPublishedProjectsInExhibitions.mockResolvedValue([{
			id: 10,
			slug: 'private-poster',
			title: 'Private Poster',
			summary: '',
			poster: {
				kind: 'IMAGE',
				status: 'READY',
				isPublic: false,
				storageKey: 'private.webp',
			},
			members: [],
			exhibitionId: 1,
		}]);

		const result = await listProjectsByYear(dependencies, '2026');

		expect(result.items[0]?.poster).toBeUndefined();
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

		await expect(getProjectDetail(dependencies, '10')).resolves.toMatchObject({
			id: 10,
			status: 'ARCHIVED',
		});
	});

	it.each(['1e3', '+1', '1.0', '0x10', '0001', '9007199254740992'])(
		'treats non-canonical numeric notation %s as a slug, never as an ID',
		async (slug) => {
			mocks.findPublishedProjectBySlug.mockResolvedValue({
				id: 10,
				slug,
				title: 'Numeric-looking slug',
				summary: '',
				description: '',
				isIncomplete: false,
				status: 'PUBLISHED',
				exhibition: { year: 2026 },
				members: [],
				assets: [],
				poster: null,
			});

			await expect(getProjectDetail(dependencies, slug)).resolves.toMatchObject({ slug });
			expect(mocks.findPublishedProjectById).not.toHaveBeenCalled();
			expect(mocks.findPublishedProjectBySlug).toHaveBeenCalledWith(slug, undefined);
		},
	);

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
					isPublic: false,
					storageKey: 'first.mov',
					playbackStorageKey: 'first.mp4',
					mimeType: 'video/quicktime',
					playbackMimeType: 'video/mp4',
					playbackStatus: 'READY',
				},
				{
					id: 2,
					kind: 'VIDEO',
					isPublic: false,
					storageKey: 'second.mp4',
					playbackStorageKey: null,
					mimeType: 'video/mp4',
					playbackMimeType: '',
					playbackStatus: 'READY',
				},
			],
			poster: null,
		});

		const result = await getProjectDetail(dependencies, '10');

		expect(result.video).toBe(result.videos[0]);
		expect(result.videos).toEqual([
			{
				url: 'https://api.example.com/api/assets/1/download?variant=playback',
				mimeType: 'video/mp4',
			},
			{
				url: 'https://api.example.com/api/assets/2/download?variant=playback',
				mimeType: 'video/mp4',
			},
		]);
	});

	it('only serializes explicitly public project images and posters', async () => {
		mocks.findPublishedProjectById.mockResolvedValue({
			id: 10,
			slug: 'mixed-visibility-images',
			title: 'Mixed Visibility Images',
			summary: '',
			description: '',
			isIncomplete: false,
			status: 'PUBLISHED',
			exhibition: { year: 2026 },
			members: [],
			assets: [
				{
					id: 1,
					kind: 'IMAGE',
					isPublic: false,
					storageKey: 'private-image.webp',
					mimeType: 'image/webp',
				},
				{
					id: 2,
					kind: 'POSTER',
					isPublic: true,
					storageKey: 'public-image.webp',
					mimeType: 'image/webp',
				},
			],
			poster: {
				kind: 'IMAGE',
				status: 'READY',
				isPublic: false,
				storageKey: 'private-poster.webp',
			},
		});

		const result = await getProjectDetail(dependencies, '10');

		expect(result.poster).toBeUndefined();
		expect(result.images).toEqual([{
			id: 2,
			kind: 'POSTER',
			image: {
				original: { url: 'https://api.example.com/api/public/images/public-image.webp' },
				renditions: [],
			},
		}]);
	});
});
