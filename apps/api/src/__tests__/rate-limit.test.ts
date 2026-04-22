import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { defaultTestEnv } from './helpers/app-mocks.js';

// Use very tight limits so the test doesn't need to send 300+ requests.
const testEnv = {
	...defaultTestEnv,
	RATE_LIMIT_GLOBAL_MAX: 5,
	RATE_LIMIT_GLOBAL_WINDOW_MS: 60_000,
	RATE_LIMIT_LOGIN_MAX: 3,
	RATE_LIMIT_LOGIN_WINDOW_MS: 60_000,
};

vi.mock('../config/env.js', () => ({
	env: () => ({ ...testEnv }),
	loadEnv: () => ({ ...testEnv }),
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
// Block auth service from hitting Google — login requests only need to reach
// the rate-limit stage, not succeed.
vi.mock('../modules/auth/service.js', () => ({
	loginWithGoogle: vi.fn().mockRejectedValue(new Error('auth disabled in test')),
	logout: vi.fn().mockResolvedValue(undefined),
	resolveSession: vi.fn().mockResolvedValue(null),
}));

describe('rate-limit plugin', () => {
	let app: FastifyInstance;

	beforeAll(async () => {
		const { buildApp } = await import('../app.js');
		app = await buildApp();
		await app.ready();
	});

	afterAll(async () => {
		await app.close();
	});

	const clientIp = '203.0.113.7';

	it('blocks a GET route after the global bucket is exhausted', async () => {
		// /api/me has no per-route override, so it uses the global bucket (max 5).
		const responses = [];
		for (let i = 0; i < 7; i++) {
			responses.push(
				await app.inject({ method: 'GET', url: '/api/me', remoteAddress: clientIp }),
			);
		}
		const codes = responses.map((r) => r.statusCode);
		const firstLimited = codes.indexOf(429);
		expect(firstLimited).toBeGreaterThanOrEqual(0);
		expect(firstLimited).toBeLessThanOrEqual(5);
		const limited = responses[firstLimited]!;
		expect(limited.headers['retry-after']).toBeDefined();
		const body = JSON.parse(limited.body);
		expect(body.ok).toBe(false);
		expect(body.error.code).toBe('RATE_LIMITED');
	});

	it('blocks the login route with its tighter bucket before the global one would', async () => {
		// Login bucket is max 3; global is max 5. The 4th login must be 429. Use a distinct IP
		// from the previous test so this bucket starts fresh.
		const loginIp = '203.0.113.8';
		const codes: number[] = [];
		for (let i = 0; i < 5; i++) {
			const res = await app.inject({
				method: 'POST',
				url: '/api/auth/google',
				payload: { credential: 'fake' },
				headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
				remoteAddress: loginIp,
			});
			codes.push(res.statusCode);
		}
		// The first three requests reach the handler (which throws "auth disabled" → 500),
		// the fourth is short-circuited by the rate limiter.
		expect(codes.slice(0, 3).every((c) => c !== 429)).toBe(true);
		expect(codes.slice(3).some((c) => c === 429)).toBe(true);
	});

	it.each(['/api/health', '/api/health/deep'])(
		'exempts %s from the rate limiter',
		async (url) => {
			const healthIp = '203.0.113.9';
			const codes: number[] = [];
			for (let i = 0; i < 10; i++) {
				const res = await app.inject({ method: 'GET', url, remoteAddress: healthIp });
				codes.push(res.statusCode);
			}
			expect(codes.every((c) => c !== 429)).toBe(true);
		},
	);
});
