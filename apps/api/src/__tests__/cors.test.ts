import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { defaultTestEnv } from './helpers/app-mocks.js';
import { registerCors } from '../plugins/cors.js';

describe('cors', () => {
	let app: FastifyInstance;
	const allowedOrigin = 'http://localhost:5173';
	const submitPaths = ['/api/me/projects/submit', '/api/admin/projects/submit'];

	function parseHeaderNames(value: string | string[] | undefined): Set<string> {
		return new Set(String(value).split(',').map((header) => header.trim().toLowerCase()));
	}

	beforeAll(async () => {
		app = Fastify({ logger: false });
		await registerCors(app, {
			...defaultTestEnv,
			LOG_LEVEL: 'info',
			GOOGLE_CLIENT_IDS: [...defaultTestEnv.GOOGLE_CLIENT_IDS],
			CORS_ALLOWED_ORIGINS: [...defaultTestEnv.CORS_ALLOWED_ORIGINS],
		});
		app.put('/api/admin/game-upload-sessions/:sessionId/chunks/:index', async () => ({ ok: true }));
		for (const path of submitPaths) {
			app.post(path, async () => ({ ok: true }));
		}
		await app.ready();
	});

	afterAll(async () => {
		await app.close();
	});

	it.each(submitPaths)('allows Idempotency-Key preflight for %s', async (url) => {
		const res = await app.inject({
			method: 'OPTIONS',
			url,
			headers: {
				origin: allowedOrigin,
				'access-control-request-method': 'POST',
				'access-control-request-headers': 'content-type,idempotency-key',
			},
		});

		expect(res.statusCode).toBe(204);
		expect(res.headers['access-control-allow-origin']).toBe(allowedOrigin);
		expect(res.headers['access-control-allow-credentials']).toBe('true');
		expect(parseHeaderNames(res.headers['access-control-allow-methods'])).toContain('post');

		const allowedHeaders = parseHeaderNames(res.headers['access-control-allow-headers']);
		for (const header of [
			'content-type',
			'authorization',
			'cookie',
			'idempotency-key',
		]) {
			expect(allowedHeaders).toContain(header);
		}
	});

	it('does not allow an unlisted origin for Idempotency-Key preflight', async () => {
		const res = await app.inject({
			method: 'OPTIONS',
			url: '/api/me/projects/submit',
			headers: {
				origin: 'https://untrusted.example',
				'access-control-request-method': 'POST',
				'access-control-request-headers': 'content-type,idempotency-key',
			},
		});

		expect(res.headers['access-control-allow-origin']).toBeUndefined();
	});

	it('allows cross-origin PUT preflight for chunked game uploads', async () => {
		const res = await app.inject({
			method: 'OPTIONS',
			url: '/api/admin/game-upload-sessions/mock-session/chunks/0',
			headers: {
				origin: allowedOrigin,
				'access-control-request-method': 'PUT',
				'access-control-request-headers': 'content-type',
			},
		});

		expect(res.statusCode).toBe(204);
		expect(res.headers['access-control-allow-origin']).toBe(allowedOrigin);
		expect(String(res.headers['access-control-allow-methods'])).toContain('PUT');
	});
});
