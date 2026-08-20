import { describe, expect, it } from 'vitest';
import {
	createResponsiveImageSerializer,
	deriveImageRenditionStorageKey,
	IMAGE_RENDITION_PROFILES,
	parseImageRenditionStorageKey,
} from '../shared/responsive-image.js';

describe('deterministic responsive image keys', () => {
	it('roundtrips arbitrary and nested canonical source keys', () => {
		for (const sourceStorageKey of [
			'123e4567-e89b-42d3-a456-426614174000.webp',
			'legacy/path with spaces/한글.poster.original',
			'prefix/__pcu_image_rendition__/v1/not-a-profile.webp/kept.webp',
		]) {
			for (const definition of IMAGE_RENDITION_PROFILES) {
				const storageKey = deriveImageRenditionStorageKey(
					sourceStorageKey,
					definition.profile,
				);
				expect(parseImageRenditionStorageKey(storageKey)).toEqual({
					sourceStorageKey,
					profile: definition.profile,
				});
			}
		}
	});

	it('rejects non-canonical versions, tokens, suffixes, and nested renditions', () => {
		expect(parseImageRenditionStorageKey('source.webp/__pcu_image_rendition__/v2/card-480.webp'))
			.toBeNull();
		expect(parseImageRenditionStorageKey('source.webp/__pcu_image_rendition__/v1/CARD-480.webp'))
			.toBeNull();
		expect(parseImageRenditionStorageKey('source.webp/__pcu_image_rendition__/v1/card-480.jpg'))
			.toBeNull();
		expect(parseImageRenditionStorageKey('source.webp/__pcu_image_rendition__/v1/card-480.webp/extra'))
			.toBeNull();
		expect(parseImageRenditionStorageKey('/__pcu_image_rendition__/v1/card-480.webp'))
			.toBeNull();

		const rendition = deriveImageRenditionStorageKey('source.webp', 'CARD_480');
		expect(() => deriveImageRenditionStorageKey(rendition, 'DISPLAY_960'))
			.toThrow(/cannot be used as a canonical image source/i);
	});

	it('enforces the S3 key limit in UTF-8 bytes at the exact boundary', () => {
		const oneCharacterKey = deriveImageRenditionStorageKey('x', 'CARD_480');
		const suffix = oneCharacterKey.slice(1);
		const availableSourceBytes = 1024 - Buffer.byteLength(suffix, 'utf8');
		const multibyteCharacters = '한'.repeat(Math.floor(availableSourceBytes / 3));
		const boundarySource = `${multibyteCharacters}${'x'.repeat(
			availableSourceBytes - Buffer.byteLength(multibyteCharacters, 'utf8'),
		)}`;
		const boundaryKey = deriveImageRenditionStorageKey(boundarySource, 'CARD_480');

		expect(Buffer.byteLength(boundaryKey, 'utf8')).toBe(1024);
		expect(parseImageRenditionStorageKey(boundaryKey)).toEqual({
			sourceStorageKey: boundarySource,
			profile: 'CARD_480',
		});
		expect(() => deriveImageRenditionStorageKey(`${boundarySource}한`, 'CARD_480'))
			.toThrow(/exceeds 1024 UTF-8 bytes/i);
		expect(parseImageRenditionStorageKey(`${boundarySource}한${suffix}`)).toBeNull();
	});
});

describe('responsive image readiness serialization', () => {
	const { serializeResponsiveImage } = createResponsiveImageSerializer('https://assets.example.test/');

	it('derives ordered rendition URLs and target widths from readiness heights', () => {
		expect(serializeResponsiveImage({
			storageKey: 'generation.webp',
			width: 1200,
			height: 800,
			card480Height: 320,
			display960Height: 640,
		})).toEqual({
			original: {
				url: 'https://assets.example.test/generation.webp',
				width: 1200,
				height: 800,
			},
			renditions: [{
				profile: 'CARD_480',
				url: 'https://assets.example.test/generation.webp/__pcu_image_rendition__/v1/card-480.webp',
				width: 480,
				height: 320,
			}, {
				profile: 'DISPLAY_960',
				url: 'https://assets.example.test/generation.webp/__pcu_image_rendition__/v1/display-960.webp',
				width: 960,
				height: 640,
			}],
		});
	});

	it('requires a present height and a source strictly wider than the profile', () => {
		expect(serializeResponsiveImage({
			storageKey: 'small.webp',
			width: 480,
			height: 240,
			card480Height: 240,
			display960Height: 480,
		}).renditions).toEqual([]);
		expect(serializeResponsiveImage({
			storageKey: 'not-ready.webp',
			width: 1200,
			height: 600,
			card480Height: null,
		}).renditions).toEqual([]);
	});

	it('keeps a legacy original usable without dimensions or readiness state', () => {
		expect(serializeResponsiveImage({ storageKey: 'legacy/nested image.png' })).toEqual({
			original: {
				url: 'https://assets.example.test/legacy/nested%20image.png',
			},
			renditions: [],
		});
	});

	it('degrades a legacy original in the reserved namespace to original-only', () => {
		const legacyReservedKey = deriveImageRenditionStorageKey('old-source.webp', 'CARD_480');
		expect(serializeResponsiveImage({
			storageKey: legacyReservedKey,
			width: 1200,
			height: 600,
			card480Height: 240,
			display960Height: 480,
		})).toEqual({
			original: {
				url: `https://assets.example.test/${legacyReservedKey}`,
				width: 1200,
				height: 600,
			},
			renditions: [],
		});
	});

	it('degrades an overlong legacy source to original-only', () => {
		const overlongKey = '한'.repeat(342);
		expect(Buffer.byteLength(overlongKey, 'utf8')).toBeGreaterThan(1024);
		expect(serializeResponsiveImage({
			storageKey: overlongKey,
			width: 1200,
			height: 600,
			card480Height: 240,
		})).toMatchObject({
			original: { width: 1200, height: 600 },
			renditions: [],
		});
	});
});
