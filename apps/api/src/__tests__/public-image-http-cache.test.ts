import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createPublicController } from '../modules/public/controller.js';

describe('retired Fastify public byte routes', () => {
	it('returns 404 for legacy image and WebGL object routes while metadata remains available', async () => {
		const app = Fastify();
		await app.register(createPublicController({
			service: {
				listYears: async () => [],
				listProjectsByYear: async () => ({ year: 2026, exhibitions: [], items: [], empty: true }),
				listProjectsByExhibition: async () => ({
					exhibition: { id: 1, year: 2026, title: 'Show' }, items: [], empty: true,
				}),
				getProjectDetail: async () => { throw new Error('not used'); },
			},
		}), { prefix: '/api/public' });

		const [image, webgl, years] = await Promise.all([
			app.inject({ method: 'GET', url: '/api/public/images/object.webp' }),
			app.inject({ method: 'GET', url: '/api/public/webgl/7/index.html' }),
			app.inject({ method: 'GET', url: '/api/public/years' }),
		]);
		expect(image.statusCode).toBe(404);
		expect(webgl.statusCode).toBe(404);
		expect(years.statusCode).toBe(200);
		await app.close();
	});
});
