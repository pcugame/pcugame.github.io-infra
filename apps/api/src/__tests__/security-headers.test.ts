import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Stub env so buildApp() doesn't try to validate real secrets.
vi.mock('../config/env.js', () => {
	const config = {
		NODE_ENV: 'test',
		PORT: 4000,
		DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
		SESSION_SECRET: 'x'.repeat(48),
		SESSION_COOKIE_NAME: 'sid',
		SESSION_IDLE_MS: 7_200_000,
		SESSION_ABSOLUTE_MS: 1_209_600_000,
		SESSION_TOUCH_MIN_INTERVAL_MS: 300_000,
		SHUTDOWN_DRAIN_MS: 15_000,
		COOKIE_SECURE: false,
		COOKIE_SAME_SITE: 'lax',
		GOOGLE_CLIENT_IDS: ['test-client-id'],
		ALLOWED_GOOGLE_HD: '',
		CORS_ALLOWED_ORIGINS: ['http://localhost:5173'],
		API_PUBLIC_URL: 'http://localhost:4000',
		WEB_PUBLIC_URL: 'http://localhost:5173',
		AUTO_PUBLISH_DEFAULT: false,
		LOG_LEVEL: 'silent',
		TRUST_PROXY: 'false',
		UPLOAD_USER_IMAGE_MAX_MB: 10,
		UPLOAD_USER_GAME_MAX_MB: 5120,
		UPLOAD_USER_REQUEST_MAX_MB: 250,
		UPLOAD_USER_MAX_FILES: 10,
		UPLOAD_PRIVILEGED_IMAGE_MAX_MB: 15,
		UPLOAD_PRIVILEGED_GAME_MAX_MB: 5120,
		UPLOAD_PRIVILEGED_REQUEST_MAX_MB: 1200,
		UPLOAD_PRIVILEGED_MAX_FILES: 20,
		UPLOAD_MAX_CONCURRENT: 5,
		UPLOAD_CHUNKED_GAME_MAX_MB: 5120,
		UPLOAD_CHUNK_SIZE_MB: 10,
		UPLOAD_SESSION_TTL_MINUTES: 1440,
		S3_ENDPOINT: 'http://localhost:3900',
		S3_REGION: 'garage',
		S3_ACCESS_KEY_ID: 'test',
		S3_SECRET_ACCESS_KEY: 'test',
		S3_BUCKET_PUBLIC: 'pcu-public',
		S3_BUCKET_PROTECTED: 'pcu-protected',
		S3_FORCE_PATH_STYLE: true,
		S3_PRESIGN_TTL_SEC: 60,
	};
	return {
		env: () => config,
		loadEnv: () => config,
	};
});

// Prisma would try to connect on buildApp; stub the methods touched by /api/health.
vi.mock('../lib/prisma.js', () => ({
	prisma: {
		$queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
	},
}));

// headObject is awaited in /api/health; make it succeed without hitting S3.
vi.mock('../lib/storage.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../lib/storage.js')>();
	return {
		...actual,
		headObject: vi.fn().mockResolvedValue(null),
	};
});

// DownloadRateLimiter loads banned IPs from DB at plugin registration; stub it out.
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
});
