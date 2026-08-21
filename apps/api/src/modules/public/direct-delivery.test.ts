import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPublicDeliveryBridgeService } from './delivery-bridge.service.js';
import { serializePublicImage } from './image-serialization.js';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('public direct delivery', () => {
	it('serializes canonical image representations directly to the public origin', async () => {
		const fallback = vi.fn();
		const image = await serializePublicImage({
			storageKey: 'legacy/image.webp',
			representations: [
				{ role: 'ORIGINAL', state: 'READY', bucket: 'public', objectKey: 'images/a b/original.webp', width: 1200, height: 800 },
				{ role: 'CARD_480', state: 'READY', bucket: 'public', objectKey: 'images/a b/card.webp', width: 480, height: 320 },
			],
		}, { publicAssetOrigin: 'https://assets.example.test', publicBucket: 'public', onLegacyFallback: fallback });

		expect(image).toEqual({
			original: { url: 'https://assets.example.test/images/a%20b/original.webp', width: 1200, height: 800 },
			renditions: [{ profile: 'CARD_480', url: 'https://assets.example.test/images/a%20b/card.webp', width: 480, height: 320 }],
		});
		expect(fallback).not.toHaveBeenCalled();
	});

	it('does not use legacy columns when a canonical representation set is malformed', async () => {
		const fallback = vi.fn();
		const image = await serializePublicImage({
			storageKey: 'legacy/image.webp',
			representations: [{ role: 'ORIGINAL', state: 'FAILED', bucket: 'public', objectKey: 'images/failed.webp' }],
		}, { publicAssetOrigin: 'https://assets.example.test', publicBucket: 'public', onLegacyFallback: fallback });
		expect(image).toBeUndefined();
		expect(fallback).not.toHaveBeenCalled();
	});

	it('keeps legacy API routes redirect-only and records fallback telemetry', async () => {
		const recordMigrationMetric = vi.fn();
		const service = createPublicDeliveryBridgeService({
			publicAssetOrigin: 'https://assets.example.test',
			publicBucket: 'public',
			logger: { warn: vi.fn() },
			repository: {
				resolvePublicImageBridge: vi.fn().mockResolvedValue({ bucket: 'public', objectKey: 'images/x.webp', usedLegacy: true }),
				findPublicWebglProject: vi.fn(),
				recordMigrationMetric,
			},
		});
		expect(await service.image('old-key')).toMatchObject({
			status: 307,
			headers: { Location: 'https://assets.example.test/images/x.webp', 'Cache-Control': 'no-store' },
		});
		expect(recordMigrationMetric).toHaveBeenCalledWith(
			'public_image_legacy_bridge', 'api-route', { usedLegacyLookup: true },
		);
	});

	it('serves a serialized URL while no API server exists', async () => {
		const origin = createServer((request, response) => {
			expect(request.url).toBe('/public/image.webp');
			response.setHeader('Content-Type', 'image/webp');
			response.end('garage-bytes');
		});
		servers.push(origin);
		await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
		const address = origin.address();
		if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
		const publicAssetOrigin = `http://127.0.0.1:${address.port}`;
		const image = await serializePublicImage({
			representations: [{ role: 'ORIGINAL', state: 'READY', bucket: 'public', objectKey: 'public/image.webp' }],
		}, { publicAssetOrigin, publicBucket: 'public' });
		const response = await fetch(image!.original.url);
		expect(await response.text()).toBe('garage-bytes');
		expect(image!.original.url).not.toContain('/api/');
	});
});
