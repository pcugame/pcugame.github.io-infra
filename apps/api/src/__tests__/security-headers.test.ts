import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { defaultTestEnv } from './helpers/app-mocks.js';

vi.mock('../config/env.js', () => ({
	env: () => ({ ...defaultTestEnv }),
	loadEnv: () => ({ ...defaultTestEnv }),
}));
vi.mock('../lib/prisma.js', () => ({
	prisma: {
		$queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
	},
}));
vi.mock('../lib/storage.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../lib/storage.js')>();
	return { ...actual, headObject: vi.fn().mockResolvedValue(null) };
});
vi.mock('../shared/game-download-limiter.js', () => ({
	gameDownloadLimiter: {
		check: vi.fn().mockReturnValue('ok'),
		isBanned: vi.fn().mockReturnValue(false),
		addBan: vi.fn(),
		removeBan: vi.fn(),
		loadBannedIps: vi.fn(),
		destroy: vi.fn(),
	},
	loadBannedIpCache: vi.fn().mockResolvedValue(undefined),
}));

describe('security headers (helmet)', () => {
	let app: FastifyInstance;

	beforeAll(async () => {
		const { buildApp } = await import('../app.js');
		app = await buildApp();
		await app.ready();
	});

	afterAll(async () => {
		await app.close();
	});

	it('sets CSP with default-src none on /api/health', async () => {
		const res = await app.inject({ method: 'GET', url: '/api/health' });
		const csp = res.headers['content-security-policy'];
		expect(csp).toBeDefined();
		expect(String(csp)).toContain("default-src 'none'");
		expect(String(csp)).toContain("frame-ancestors 'none'");
	});

	it('sets HSTS and X-Frame-Options', async () => {
		const res = await app.inject({ method: 'GET', url: '/api/health' });
		expect(res.headers['strict-transport-security']).toMatch(/max-age=31536000/);
		expect(res.headers['x-frame-options']).toBe('DENY');
	});

	it('sets X-Content-Type-Options and Referrer-Policy', async () => {
		const res = await app.inject({ method: 'GET', url: '/api/health' });
		expect(res.headers['x-content-type-options']).toBe('nosniff');
		expect(res.headers['referrer-policy']).toBe('no-referrer');
	});

	it('sets Cross-Origin-Resource-Policy to cross-origin (web is a different origin)', async () => {
		const res = await app.inject({ method: 'GET', url: '/api/health' });
		expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
	});

	it('emits x-request-id on every response', async () => {
		const res = await app.inject({ method: 'GET', url: '/api/health' });
		const reqId = res.headers['x-request-id'];
		expect(reqId).toBeDefined();
		expect(String(reqId)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	it('generates a distinct x-request-id per request', async () => {
		const a = await app.inject({ method: 'GET', url: '/api/health' });
		const b = await app.inject({ method: 'GET', url: '/api/health' });
		expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
	});
});
