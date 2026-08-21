import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPublicController } from '../modules/public/controller.js';
import { createPublicDeliveryBridgeService } from '../modules/public/delivery-bridge.service.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
	await Promise.allSettled(apps.splice(0).map((app) => app.close()));
});

async function start(app: FastifyInstance): Promise<string> {
	apps.push(app);
	return app.listen({ host: '127.0.0.1', port: 0 });
}

describe('public image direct-origin bridge', () => {
	it('redirects the legacy API bridge without a body, while the immutable public URL remains usable after API shutdown', async () => {
		const publicOrigin = Fastify();
		publicOrigin.get('/public/images/generation-1.webp', async (_request, reply) => {
			reply.header('Cache-Control', 'public, max-age=31536000, immutable');
			reply.header('ETag', '"generation-1"');
			return reply.type('image/webp').send('garage-bytes');
		});
		const publicOriginUrl = await start(publicOrigin);
		const resolvePublicImageBridge = vi.fn(async () => ({
			bucket: 'pcu-public',
			objectKey: 'public/images/generation-1.webp',
			usedLegacy: false,
		}));
		const bridge = createPublicDeliveryBridgeService({
			publicAssetOrigin: publicOriginUrl,
			publicBucket: 'pcu-public',
			logger: { warn: vi.fn() },
			repository: {
				resolvePublicImageBridge,
				findPublicWebglProject: vi.fn(),
			},
		});
		const api = Fastify();
		await api.register(createPublicController({ service: {} as never, deliveryBridge: bridge }), {
			prefix: '/api/public',
		});
		apps.push(api);

		const bridgeResponse = await api.inject({
			method: 'GET',
			url: '/api/public/images/public/images/generation-1.webp',
		});
		expect(bridgeResponse.statusCode).toBe(307);
		expect(bridgeResponse.body).toBe('');
		expect(bridgeResponse.headers).toMatchObject({
			location: `${publicOriginUrl}/public/images/generation-1.webp`,
			'cache-control': 'no-store',
			'referrer-policy': 'no-referrer',
		});
		expect(resolvePublicImageBridge).toHaveBeenCalledWith('public/images/generation-1.webp');

		await api.close();
		const direct = await fetch(`${publicOriginUrl}/public/images/generation-1.webp`);
		expect(direct.status).toBe(200);
		expect(direct.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
		expect(direct.headers.get('etag')).toBe('"generation-1"');
		expect(await direct.text()).toBe('garage-bytes');
	});

	it('keeps GET and HEAD compatibility routes as byte-free 307 capabilities', async () => {
		const bridge = createPublicDeliveryBridgeService({
			publicAssetOrigin: 'https://assets.example.test',
			publicBucket: 'pcu-public',
			logger: { warn: vi.fn() },
			repository: {
				resolvePublicImageBridge: vi.fn(async () => ({
					bucket: 'pcu-public', objectKey: 'images/nested/card.webp', usedLegacy: true,
				})),
				findPublicWebglProject: vi.fn(),
			},
		});
		const api = Fastify();
		await api.register(createPublicController({ service: {} as never, deliveryBridge: bridge }), {
			prefix: '/api/public',
		});
		apps.push(api);

		for (const method of ['GET', 'HEAD'] as const) {
			const response = await api.inject({ method, url: '/api/public/assets/images/nested/card.webp' });
			expect(response.statusCode).toBe(307);
			expect(response.body).toBe('');
			expect(response.headers.location).toBe('https://assets.example.test/images/nested/card.webp');
		}
	});

	it('does not mint a public URL for an unowned legacy key', async () => {
		const resolvePublicImageBridge = vi.fn(async () => null);
		const bridge = createPublicDeliveryBridgeService({
			publicAssetOrigin: 'https://assets.example.test',
			publicBucket: 'pcu-public',
			logger: { warn: vi.fn() },
			repository: { resolvePublicImageBridge, findPublicWebglProject: vi.fn() },
		});
		const api = Fastify();
		await api.register(createPublicController({ service: {} as never, deliveryBridge: bridge }), {
			prefix: '/api/public',
		});
		apps.push(api);

		const response = await api.inject({ method: 'GET', url: '/api/public/images/stale.webp' });
		expect(response.statusCode).toBe(404);
		expect(response.headers.location).toBeUndefined();
		expect(resolvePublicImageBridge).toHaveBeenCalledWith('stale.webp');
	});
});
