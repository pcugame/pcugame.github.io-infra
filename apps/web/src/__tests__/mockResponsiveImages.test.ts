/* @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest';

import { findProjectDetail, MOCK_YEARS, mockResponsiveImage } from '../lib/api/mock/data';
import { resetMockState, selectMockUser } from '../lib/api/mock/transport';

function expectDeclaredPlaceholderSize(
	url: string,
	width: number | undefined,
	height: number | undefined,
): void {
	const match = /\/mock\/images\/(\d+)x(\d+)\.png/.exec(url);
	expect(match).not.toBeNull();
	expect(Number(match?.[1])).toBe(width);
	expect(Number(match?.[2])).toBe(height);
}

describe('responsive image mock fixtures', () => {
 beforeEach(async () => { await resetMockState(); await selectMockUser('ADMIN'); });
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

	it('serves local URLs whose pixel sizes match every declared candidate', () => {
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

	it('uses the same size-consistent fixture helper for uploaded posters', () => {
 const poster=mockResponsiveImage('/mock/images/1200x675.png');
 expectDeclaredPlaceholderSize(poster.original.url,poster.original.width,poster.original.height);
 for(const rendition of poster.renditions)expectDeclaredPlaceholderSize(rendition.url,rendition.width,rendition.height);
 });
});
