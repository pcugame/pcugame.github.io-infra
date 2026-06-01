import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { defaultTestEnv } from './helpers/app-mocks.js';
import { registerCors } from '../plugins/cors.js';

vi.mock('../config/env.js', () => ({
	env: () => ({ ...defaultTestEnv }),
	loadEnv: () => ({ ...defaultTestEnv }),
}));

describe('cors', () => {
	let app: FastifyInstance;

	beforeAll(async () => {
		app = Fastify({ logger: false });
		await registerCors(app);
		app.put('/api/admin/game-upload-sessions/:sessionId/chunks/:index', async () => ({ ok: true }));
		await app.ready();
	});

	afterAll(async () => {
		await app.close();
	});

	it('allows cross-origin PUT preflight for chunked game uploads', async () => {
		const res = await app.inject({
			method: 'OPTIONS',
			url: '/api/admin/game-upload-sessions/mock-session/chunks/0',
			headers: {
				origin: 'http://localhost:5173',
				'access-control-request-method': 'PUT',
				'access-control-request-headers': 'content-type',
			},
		});

		expect(res.statusCode).toBe(204);
		expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
		expect(String(res.headers['access-control-allow-methods'])).toContain('PUT');
	});
});
