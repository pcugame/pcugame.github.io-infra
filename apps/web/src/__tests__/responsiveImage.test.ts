import { describe, expect, it } from 'vitest';
import type { ResponsiveImage } from '@pcu/contracts';

import {
	buildImageCandidates,
	buildSrcSet,
	pickRendition,
	sortImageRenditions,
} from '../lib/responsive-image';

const image: ResponsiveImage = {
	original: {
		url: 'https://images.test/original.webp',
		width: 1600,
		height: 900,
	},
	renditions: [
		{
			profile: 'DISPLAY_960',
			url: 'https://images.test/display.webp',
			width: 960,
			height: 540,
		},
		{
			profile: 'CARD_480',
			url: 'https://images.test/card.webp',
			width: 480,
			height: 270,
		},
	],
};

describe('responsive image helpers', () => {
	it('sorts renditions by profile without mutating the response', () => {
		const originalOrder = image.renditions.map((rendition) => rendition.profile);
		const sorted = sortImageRenditions(image.renditions);

		expect(sorted.map((rendition) => rendition.profile)).toEqual([
			'CARD_480',
			'DISPLAY_960',
		]);
		expect(image.renditions.map((rendition) => rendition.profile)).toEqual(originalOrder);
	});

	it('builds sorted source candidates and removes duplicate profiles and widths', () => {
		const candidates = buildImageCandidates({
			...image,
			renditions: [
				...image.renditions,
				{
					profile: 'CARD_480',
					url: 'https://images.test/card-wrong-width.webp',
					width: 470,
					height: 264,
				},
				{
					profile: 'DISPLAY_960',
					url: 'https://images.test/display-duplicate-width.webp',
					width: 480,
					height: 270,
				},
			],
		});

		expect(candidates).toEqual([
			expect.objectContaining({ kind: 'rendition', profile: 'CARD_480', width: 480 }),
			expect.objectContaining({ kind: 'rendition', profile: 'DISPLAY_960', width: 960 }),
			expect.objectContaining({ kind: 'original', width: 1600 }),
		]);
	});

	it('builds an ascending width srcset including the canonical source', () => {
		expect(buildSrcSet(image)).toBe([
			'https://images.test/card.webp 480w',
			'https://images.test/display.webp 960w',
			'https://images.test/original.webp 1600w',
		].join(', '));
	});

	it('uses the original as a legacy no-rendition fallback', () => {
		const legacy: ResponsiveImage = {
			original: { url: 'https://images.test/legacy.webp' },
			renditions: [],
		};

		expect(buildImageCandidates(legacy)).toEqual([
			{ kind: 'original', url: legacy.original.url, width: undefined, height: undefined },
		]);
		expect(buildSrcSet(legacy)).toBeUndefined();
		expect(pickRendition(legacy, 960).url).toBe(legacy.original.url);
	});

	it('picks the closest sufficient rendition for 480 and 960 targets', () => {
		expect(pickRendition(image, 480).profile).toBe('CARD_480');
		expect(pickRendition(image, 960).profile).toBe('DISPLAY_960');
		expect(pickRendition(image, 1200).kind).toBe('original');
	});

	it('uses the original when the source itself is smaller than the target', () => {
		const smallSource: ResponsiveImage = {
			original: {
				url: 'https://images.test/small.webp',
				width: 800,
				height: 450,
			},
			renditions: [{
				profile: 'CARD_480',
				url: 'https://images.test/small-card.webp',
				width: 480,
				height: 270,
			}],
		};

		expect(pickRendition(smallSource, 960).url).toBe(smallSource.original.url);
	});
});
