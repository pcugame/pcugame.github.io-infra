import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { defaultTestEnv } from './helpers/app-mocks.js';
import { registerCors } from '../plugins/cors.js';

describe('cors', () => {
	let app: FastifyInstance;
	const allowedOrigin = 'http://localhost:5173';

	beforeAll(async () => {
		app = Fastify({ logger: false });
		await registerCors(app, {
			...defaultTestEnv,
			LOG_LEVEL: 'info',
			GOOGLE_CLIENT_IDS: [...defaultTestEnv.GOOGLE_CLIENT_IDS],
			CORS_ALLOWED_ORIGINS: [...defaultTestEnv.CORS_ALLOWED_ORIGINS],
		});
		app.post('/api/me/projects/submit', async () => ({ ok: true }));
		app.post('/api/admin/projects/submit', async () => ({ ok: true }));
		app.post('/api/admin/direct-asset-upload-sessions/:sessionId/part-urls', async () => ({ ok: true }));
		await app.ready();
	});

	afterAll(async () => {
		await app.close();
	});

	it('allows cross-origin POST preflight for direct upload controls', async () => {
		const res = await app.inject({
			method: 'OPTIONS',
			url: '/api/admin/direct-asset-upload-sessions/mock-session/part-urls',
			headers: {
				origin: allowedOrigin,
				'access-control-request-method': 'POST',
				'access-control-request-headers': 'content-type',
			},
		});

		expect(res.statusCode).toBe(204);
		expect(res.headers['access-control-allow-origin']).toBe(allowedOrigin);
		expect(String(res.headers['access-control-allow-methods'])).toContain('POST');
	});

	for (const [audience, url] of [
		['USER', '/api/me/projects/submit'],
		['ADMIN', '/api/admin/projects/submit'],
	] as const) {
		it(`allows Idempotency-Key preflight for ${audience} project submission`, async () => {
			const res = await app.inject({
				method: 'OPTIONS',
				url,
				headers: {
					origin: allowedOrigin,
					'access-control-request-method': 'POST',
					'access-control-request-headers': 'content-type, idempotency-key',
				},
			});

			const allowedHeaders = String(res.headers['access-control-allow-headers'])
				.split(',')
				.map((header) => header.trim().toLowerCase())
				.filter(Boolean)
				.sort();

			expect(res.statusCode).toBe(204);
			expect(res.headers['access-control-allow-origin']).toBe(allowedOrigin);
			expect(res.headers['access-control-allow-credentials']).toBe('true');
			expect(res.headers.vary).toBe('Origin');
			expect(String(res.headers['access-control-allow-methods'])).toContain('POST');
			expect(allowedHeaders).toEqual(['authorization', 'content-type', 'idempotency-key']);
			expect(allowedHeaders).not.toContain('cookie');
			expect(allowedHeaders).not.toContain('*');
		});
	}

	it('does not allow untrusted origins to preflight project submission', async () => {
		const res = await app.inject({
			method: 'OPTIONS',
			url: '/api/me/projects/submit',
			headers: {
				origin: 'https://untrusted.example',
				'access-control-request-method': 'POST',
				'access-control-request-headers': 'content-type, idempotency-key',
			},
		});

		expect(res.headers['access-control-allow-origin']).toBeUndefined();
	});
});
