import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultTestEnv } from './helpers/app-mocks.js';

const mocks = vi.hoisted(() => ({
	findAllExhibitions: vi.fn(),
	findExhibitionByComposite: vi.fn(),
	createExhibition: vi.fn(),
	findExhibitionById: vi.fn(),
	findExhibitionByIdWithCount: vi.fn(),
	updateExhibition: vi.fn(),
	deleteExhibition: vi.fn(),
	clearExhibitionPoster: vi.fn(),
	safeDeleteObject: vi.fn(),
}));

vi.mock('../config/env.js', () => ({
	env: () => ({ ...defaultTestEnv, API_PUBLIC_URL: 'https://api.example.test' }),
	loadEnv: () => ({ ...defaultTestEnv, API_PUBLIC_URL: 'https://api.example.test' }),
}));

vi.mock('../lib/s3.js', () => ({
	bucketForKind: vi.fn(() => 'public-bucket'),
}));

vi.mock('../lib/storage.js', () => ({
	safeDeleteObject: mocks.safeDeleteObject,
}));

vi.mock('../modules/admin/year/repository.js', () => ({
	findAllExhibitions: mocks.findAllExhibitions,
	findExhibitionByComposite: mocks.findExhibitionByComposite,
	createExhibition: mocks.createExhibition,
	findExhibitionById: mocks.findExhibitionById,
	findExhibitionByIdWithCount: mocks.findExhibitionByIdWithCount,
	updateExhibition: mocks.updateExhibition,
	deleteExhibition: mocks.deleteExhibition,
	clearExhibitionPoster: mocks.clearExhibitionPoster,
}));

import {
	createExhibition,
	deleteExhibition,
	deletePoster,
	listExhibitions,
	updateExhibition,
} from '../modules/admin/year/service.js';

function exhibition(overrides: Record<string, unknown> = {}) {
	return {
		id: 1,
		year: 2026,
		title: '',
		isUploadEnabled: true,
		sortOrder: 0,
		posterStorageKey: null,
		posterOriginalName: '',
		posterSizeBytes: 0n,
		_count: { projects: 0 },
		...overrides,
	};
}

describe('admin exhibition service', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('serializes exhibition list items with optional poster metadata', async () => {
		mocks.findAllExhibitions.mockResolvedValue([
			exhibition({
				title: 'Graduation Show',
				posterStorageKey: 'poster.webp',
				posterOriginalName: 'poster.pdf',
				posterSizeBytes: 1234n,
				_count: { projects: 3 },
			}),
			exhibition({ id: 2, year: 2025 }),
		]);

		await expect(listExhibitions()).resolves.toEqual([
			{
				id: 1,
				year: 2026,
				title: 'Graduation Show',
				isUploadEnabled: true,
				sortOrder: 0,
				projectCount: 3,
				posterUrl: 'https://api.example.test/api/public/exhibition-posters/poster.webp',
				posterOriginalName: 'poster.pdf',
				posterSize: 1234,
			},
			{
				id: 2,
				year: 2025,
				title: undefined,
				isUploadEnabled: true,
				sortOrder: 0,
				projectCount: 0,
				posterUrl: undefined,
				posterOriginalName: undefined,
				posterSize: undefined,
			},
		]);
	});

	it('creates an exhibition when the year-title pair is unused', async () => {
		mocks.findExhibitionByComposite.mockResolvedValue(null);
		mocks.createExhibition.mockResolvedValue({ id: 7, year: 2027 });

		await expect(createExhibition({ year: 2027, title: 'Show' })).resolves.toEqual({
			id: 7,
			year: 2027,
		});
		expect(mocks.findExhibitionByComposite).toHaveBeenCalledWith(2027, 'Show');
		expect(mocks.createExhibition).toHaveBeenCalledWith({ year: 2027, title: 'Show' });
	});

	it('rejects duplicate exhibition year-title pairs', async () => {
		mocks.findExhibitionByComposite.mockResolvedValue({ id: 1 });

		await expect(createExhibition({ year: 2027 })).rejects.toMatchObject({
			statusCode: 409,
			code: 'CONFLICT',
		});
		expect(mocks.createExhibition).not.toHaveBeenCalled();
	});

	it('updates only fields present in the patch', async () => {
		mocks.findExhibitionById.mockResolvedValue(exhibition());
		mocks.updateExhibition.mockResolvedValue(exhibition({
			title: 'Updated',
			isUploadEnabled: false,
			_count: { projects: 2 },
		}));

		const result = await updateExhibition(1, { title: 'Updated', isUploadEnabled: false });

		expect(mocks.updateExhibition).toHaveBeenCalledWith(1, {
			title: 'Updated',
			isUploadEnabled: false,
		});
		expect(result).toMatchObject({
			title: 'Updated',
			isUploadEnabled: false,
			projectCount: 2,
		});
	});

	it('throws 404 when updating or deleting a missing exhibition', async () => {
		mocks.findExhibitionById.mockResolvedValue(null);
		mocks.findExhibitionByIdWithCount.mockResolvedValue(null);

		await expect(updateExhibition(404, { title: 'Missing' })).rejects.toMatchObject({
			statusCode: 404,
		});
		await expect(deleteExhibition(404)).rejects.toMatchObject({
			statusCode: 404,
		});
	});

	it('deletes the DB row and best-effort deletes an existing poster object', async () => {
		mocks.findExhibitionByIdWithCount.mockResolvedValue(exhibition({
			posterStorageKey: 'old-poster.webp',
		}));
		mocks.deleteExhibition.mockResolvedValue({});

		await deleteExhibition(1);

		expect(mocks.deleteExhibition).toHaveBeenCalledWith(1);
		expect(mocks.safeDeleteObject).toHaveBeenCalledWith(
			'public-bucket',
			'old-poster.webp',
			'exhibition-delete-poster',
			{ exhibitionId: 1 },
		);
	});

	it('clears poster metadata and deletes the old poster object', async () => {
		mocks.clearExhibitionPoster.mockResolvedValue({
			updated: exhibition(),
			oldStorageKey: 'old-poster.webp',
		});

		await deletePoster(1);

		expect(mocks.safeDeleteObject).toHaveBeenCalledWith(
			'public-bucket',
			'old-poster.webp',
			'exhibition-poster-delete',
			{ exhibitionId: 1 },
		);
	});

	it('throws 404 when deleting a poster for a missing exhibition', async () => {
		mocks.clearExhibitionPoster.mockResolvedValue(null);

		await expect(deletePoster(404)).rejects.toMatchObject({
			statusCode: 404,
		});
	});
});
