import { describe, expect, it } from 'vitest';

import type { ResponsiveImage } from '../contracts';
import { findProjectDetail, MOCK_YEARS } from '../lib/api/mock/data';
import { handleMockRequest } from '../lib/api/mock/handler';

function expectDeclaredPlaceholderSize(
	url: string,
	width: number | undefined,
	height: number | undefined,
): void {
	const match = /placehold\.co\/(\d+)x(\d+)/.exec(url);
	expect(match).not.toBeNull();
	expect(Number(match?.[1])).toBe(width);
	expect(Number(match?.[2])).toBe(height);
}

describe('responsive image mock fixtures', () => {
	it('keeps an explicit legacy no-rendition response', () => {
		const poster = MOCK_YEARS[0]?.poster;
		expect(poster).toBeDefined();
		expect(poster?.renditions).toEqual([]);
		expectDeclaredPlaceholderSize(
			poster!.original.url,
			poster!.original.width,
			poster!.original.height,
		);
	});

	it('serves placeholder URLs whose pixel sizes match every declared candidate', () => {
		const detail = findProjectDetail('dragon-slayer');
		expect(detail).toBeDefined();

		for (const { image } of detail!.images) {
			expectDeclaredPlaceholderSize(
				image.original.url,
				image.original.width,
				image.original.height,
			);
			for (const rendition of image.renditions) {
				expectDeclaredPlaceholderSize(
					rendition.url,
					rendition.width,
					rendition.height,
				);
			}
		}
	});

	it('uses the same size-consistent fixture helper for poster upload responses', async () => {
		const response = await handleMockRequest<{ poster: ResponsiveImage }>(
			'/api/admin/exhibitions/2/poster',
			{ method: 'POST' },
		);

		expectDeclaredPlaceholderSize(
			response.poster.original.url,
			response.poster.original.width,
			response.poster.original.height,
		);
		for (const rendition of response.poster.renditions) {
			expectDeclaredPlaceholderSize(rendition.url, rendition.width, rendition.height);
		}
	});
});
