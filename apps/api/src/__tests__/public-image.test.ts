import { describe, expect, it } from 'vitest';
import {
	createResponsiveImageSerializer,
	deriveImageRenditionStorageKey,
	publicObjectUrl,
} from '../shared/responsive-image.js';

describe('public image origin serialization', () => {
	it('returns immutable object-origin URLs without using the API host', () => {
		const serializer = createResponsiveImageSerializer('https://assets.example.test/public/');
		const sourceKey = 'images/generation id/poster (final).webp';
		const result = serializer.serializeResponsiveImage({
			storageKey: sourceKey,
			width: 1200,
			height: 900,
			card480Height: 360,
			display960Height: 720,
		});

		expect(result.original.url).toBe(
			'https://assets.example.test/public/images/generation%20id/poster%20%28final%29.webp',
		);
		expect(result.renditions.map(({ url }) => url)).toEqual([
			publicObjectUrl(
				'https://assets.example.test/public',
				deriveImageRenditionStorageKey(sourceKey, 'CARD_480'),
			),
			publicObjectUrl(
				'https://assets.example.test/public',
				deriveImageRenditionStorageKey(sourceKey, 'DISPLAY_960'),
			),
		]);
		expect(JSON.stringify(result)).not.toContain('/api/public/images');
	});

	it('rejects empty and absolute object keys at the serializer boundary', () => {
		expect(() => publicObjectUrl('https://assets.example.test', '')).toThrow();
		expect(() => publicObjectUrl('https://assets.example.test', '/object.webp')).toThrow();
	});
});
