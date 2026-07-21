import { Readable } from 'node:stream';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { defaultTestEnv } from './helpers/app-mocks.js';

const mocks = vi.hoisted(() => ({
	findPublicWebglProject: vi.fn(),
	headObject: vi.fn(),
	getObjectStream: vi.fn(),
}));

vi.mock('../config/env.js', () => ({
	env: () => ({ ...defaultTestEnv }),
	loadEnv: () => ({ ...defaultTestEnv }),
}));
vi.mock('../modules/public/repository.js', () => ({
	findPublicWebglProject: mocks.findPublicWebglProject,
}));
vi.mock('../lib/storage.js', () => ({
	getPresignedUrl: vi.fn(),
	headObject: mocks.headObject,
	getObjectStream: mocks.getObjectStream,
}));

import { registerCors } from '../plugins/cors.js';
import { registerHelmet } from '../plugins/helmet.js';
import { publicController } from '../modules/public/controller.js';
import { normalizeWebglRequestPath, parseSingleByteRange } from '../modules/public/webgl.service.js';

const deployment = '123e4567-e89b-42d3-a456-426614174000';

describe('public WebGL hosting route', () => {
	let app: FastifyInstance;

	beforeAll(async () => {
		app = Fastify();
		await registerHelmet(app);
		await registerCors(app, {
			...defaultTestEnv,
			LOG_LEVEL: 'info',
			GOOGLE_CLIENT_IDS: [...defaultTestEnv.GOOGLE_CLIENT_IDS],
			CORS_ALLOWED_ORIGINS: [...defaultTestEnv.CORS_ALLOWED_ORIGINS],
		});
		await app.register(publicController, { prefix: '/api/public' });
		await app.ready();
	});

	afterAll(async () => {
		await app.close();
	});

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findPublicWebglProject.mockResolvedValue({
			id: 7,
			webglEntryKey: `webgl/7/${deployment}/site/index.html`,
		});
		mocks.headObject.mockResolvedValue({ size: 10, contentType: 'application/octet-stream' });
		mocks.getObjectStream.mockImplementation(async (_bucket, _key, range) => {
			const size = range ? range.end - range.start + 1 : 10;
			return {
				body: Readable.from([Buffer.alloc(size, 65)]),
				size,
				contentType: 'application/octet-stream',
				contentRange: range ? `bytes ${range.start}-${range.end}/10` : undefined,
				etag: '"etag"',
			};
		});
	});

	it('serves the active index anonymously with credential-free CORS and frame policy', async () => {
		const response = await app.inject({
			method: 'GET',
			url: '/api/public/webgl/7/',
			headers: { origin: 'null' },
		});
		expect(response.statusCode).toBe(200);
		expect(response.headers['content-type']).toContain('text/html');
		expect(response.headers['access-control-allow-origin']).toBe('*');
		expect(response.headers['access-control-allow-credentials']).toBeUndefined();
		expect(response.headers['x-frame-options']).toBeUndefined();
		expect(response.headers['content-security-policy']).toContain(
			'frame-ancestors http://localhost:5173',
		);
		expect(mocks.getObjectStream).toHaveBeenCalledWith(
			'pcu-public',
			`webgl/7/${deployment}/site/index.html`,
			undefined,
		);
	});

	it('serves encoded WASM resources with single-range semantics', async () => {
		const response = await app.inject({
			method: 'GET',
			url: '/api/public/webgl/7/Build/game.wasm.br',
			headers: { range: 'bytes=2-5', origin: 'null' },
		});
		expect(response.statusCode).toBe(206);
		expect(response.headers['content-type']).toContain('application/wasm');
		expect(response.headers['content-encoding']).toBe('br');
		expect(response.headers['accept-ranges']).toBe('bytes');
		expect(response.headers['content-range']).toBe('bytes 2-5/10');
		expect(response.headers['content-length']).toBe('4');
	});

	it('returns 416 for invalid or multiple ranges', async () => {
		const response = await app.inject({
			method: 'GET',
			url: '/api/public/webgl/7/Build/game.data',
			headers: { range: 'bytes=1-2,4-5' },
		});
		expect(response.statusCode).toBe(416);
		expect(response.headers['content-range']).toBe('bytes */10');
		expect(mocks.getObjectStream).not.toHaveBeenCalled();
	});

	it('blocks missing/inactive project pointers before storage access', async () => {
		mocks.findPublicWebglProject.mockResolvedValueOnce(null);
		const response = await app.inject({
			method: 'GET',
			url: '/api/public/webgl/7/',
			headers: { origin: 'null' },
		});
		expect(response.statusCode).toBe(404);
		expect(response.headers['access-control-allow-origin']).toBe('*');
		expect(response.headers['access-control-allow-credentials']).toBeUndefined();
		expect(response.headers['x-frame-options']).toBeUndefined();
		expect(mocks.headObject).not.toHaveBeenCalled();
	});

	it('handles sandbox-origin preflight without credentials', async () => {
		const response = await app.inject({
			method: 'OPTIONS',
			url: '/api/public/webgl/7/Build/game.data',
			headers: {
				origin: 'null',
				'access-control-request-method': 'GET',
				'access-control-request-headers': 'range',
			},
		});
		expect(response.statusCode).toBe(204);
		expect(response.headers['access-control-allow-origin']).toBe('*');
		expect(response.headers['access-control-allow-credentials']).toBeUndefined();
		expect(response.headers['access-control-allow-headers']).toContain('Range');
	});
});

describe('WebGL request path and range parsing', () => {
	it('rejects traversal and backslash traversal after URL decoding', () => {
		expect(() => normalizeWebglRequestPath('../source.zip')).toThrow('Invalid WebGL asset path');
		expect(() => normalizeWebglRequestPath('Build\\..\\source.zip')).toThrow('Invalid WebGL asset path');
	});

	it('supports open and suffix byte ranges', () => {
		expect(parseSingleByteRange('bytes=4-', 10)).toEqual({ start: 4, end: 9 });
		expect(parseSingleByteRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
		expect(parseSingleByteRange('bytes=10-', 10)).toBe('invalid');
	});
});
