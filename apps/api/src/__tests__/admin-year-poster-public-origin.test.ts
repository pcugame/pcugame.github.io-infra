import { describe, expect, it, vi } from 'vitest';
import { createExhibitionService } from '../modules/admin/year/service.js';
import type { ExhibitionRecord } from '../modules/admin/year/ports.js';

const publicBucket = 'pcu-public';
const origin = 'https://assets.example.test';

function exhibition(poster: ExhibitionRecord['poster']): ExhibitionRecord {
	return {
		id: 7, year: 2026, title: 'Show', isModificationEnabled: true, sortOrder: 0,
		posterAssetId: 42, poster, _count: { projects: 3 },
	};
}

function serviceFor(poster: ExhibitionRecord['poster']) {
	const repository = {
		findAllExhibitions: vi.fn(async () => [exhibition(poster)]),
		findExhibitionByComposite: vi.fn(),
		findExhibitionById: vi.fn(async () => ({ id: 7 })),
		findExhibitionByIdWithCount: vi.fn(),
		createExhibition: vi.fn(),
		deleteExhibition: vi.fn(),
		updateExhibition: vi.fn(async () => exhibition(poster)),
		clearExhibitionPoster: vi.fn(),
	};
	return {
		repository,
		service: createExhibitionService({
			publicAssetOrigin: origin,
			posterBucket: publicBucket,
			protectedBucket: 'pcu-protected',
			repository,
			wakeDeletionWorker: vi.fn(),
		}),
	};
}

describe('admin exhibition poster canonical public delivery', () => {
	it('lists and updates a canonical poster with direct public-origin URLs', async () => {
		const poster = {
			id: 42, status: 'READY', originalName: 'poster.webp', representations: [
				{ role: 'ORIGINAL', bucket: publicBucket, objectKey: 'public/images/42/original/g1.webp', state: 'READY', sizeBytes: 100n, width: 1200, height: 800 },
				{ role: 'CARD_480', bucket: publicBucket, objectKey: 'public/images/42/card/g1.webp', state: 'READY', sizeBytes: 50n, width: 480, height: 320 },
				{ role: 'DISPLAY_960', bucket: publicBucket, objectKey: 'public/images/42/display/g1.webp', state: 'READY', sizeBytes: 75n, width: 960, height: 640 },
			],
		};
		const { service } = serviceFor(poster);

		const [listed] = await service.listExhibitions();
		const updated = await service.updateExhibition(7, { title: 'Renamed' });

		for (const response of [listed, updated]) {
			expect(response?.poster?.original.url).toBe(`${origin}/public/images/42/original/g1.webp`);
			expect(response?.poster?.renditions.map((rendition) => rendition.url)).toEqual([
				`${origin}/public/images/42/card/g1.webp`,
				`${origin}/public/images/42/display/g1.webp`,
			]);
			expect(response?.poster?.original.url).not.toContain('/api/');
		}
	});

	it('fails closed for a malformed or non-public canonical representation set', async () => {
		const { service } = serviceFor({
			id: 42, status: 'READY', originalName: 'poster.webp', representations: [
				{ role: 'ORIGINAL', bucket: 'pcu-protected', objectKey: 'protected/uploads/42/source.webp', state: 'READY', sizeBytes: 100n, width: 1200, height: 800 },
				{ role: 'CARD_480', bucket: publicBucket, objectKey: 'public/images/42/card.webp', state: 'PENDING', sizeBytes: 50n, width: 480, height: 320 },
			],
		});

		const [listed] = await service.listExhibitions();
		expect(listed?.poster).toBeUndefined();
	});
});
