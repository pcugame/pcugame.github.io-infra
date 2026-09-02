import { createServer } from 'node:http';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createPublicController } from './controller.js';
import { serializePublicImage } from './image-serialization.js';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('public direct delivery', () => {
	it('serializes canonical image representations directly to the public origin', async () => {
		const image = await serializePublicImage({
			representations: [
				{ role: 'ORIGINAL', state: 'READY', bucket: 'public', objectKey: 'images/a b/original.webp', width: 1200, height: 800 },
				{ role: 'CARD_480', state: 'READY', bucket: 'public', objectKey: 'images/a b/card.webp', width: 480, height: 320 },
			],
		}, { publicAssetOrigin: 'https://assets.example.test', publicBucket: 'public' });

		expect(image).toEqual({
			original: { url: 'https://assets.example.test/images/a%20b/original.webp', width: 1200, height: 800 },
			renditions: [{ profile: 'CARD_480', url: 'https://assets.example.test/images/a%20b/card.webp', width: 480, height: 320 }],
		});
	});

	it('fails closed when a canonical representation set is malformed', async () => {
		const image = await serializePublicImage({
			representations: [{ role: 'ORIGINAL', state: 'FAILED', bucket: 'public', objectKey: 'images/failed.webp' }],
		}, { publicAssetOrigin: 'https://assets.example.test', publicBucket: 'public' });
		expect(image).toBeUndefined();
	});

	it('does not register storage-key image or project-id WebGL routes', async () => {
		const app = Fastify();
		await app.register(createPublicController({ service: {} as never }), { prefix: '/api/public' });
		await app.ready();
		for (const url of [
			'/api/public/images/old-key.webp',
			'/api/public/assets/old-key.webp',
			'/api/public/webgl/7/index.html',
		]) expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
		await app.close();
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
