import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { defaultTestEnv } from './helpers/app-mocks.js';
import { registerCors } from '../plugins/cors.js';

describe('cors', () => {
	let app: FastifyInstance;

	beforeAll(async () => {
		app = Fastify({ logger: false });
		await registerCors(app, {
			...defaultTestEnv,
			LOG_LEVEL: 'info',
			GOOGLE_CLIENT_IDS: [...defaultTestEnv.GOOGLE_CLIENT_IDS],
			CORS_ALLOWED_ORIGINS: [...defaultTestEnv.CORS_ALLOWED_ORIGINS],
		});
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
				origin: 'http://localhost:5173',
				'access-control-request-method': 'POST',
				'access-control-request-headers': 'content-type',
			},
		});

		expect(res.statusCode).toBe(204);
		expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
		expect(String(res.headers['access-control-allow-methods'])).toContain('POST');
	});
});
