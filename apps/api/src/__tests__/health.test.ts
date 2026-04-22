import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { defaultTestEnv } from './helpers/app-mocks.js';

const headObjectMock = vi.fn().mockResolvedValue(null);
const queryRawMock = vi.fn().mockResolvedValue([{ '?column?': 1 }]);

vi.mock('../config/env.js', () => ({
	env: () => ({ ...defaultTestEnv }),
	loadEnv: () => ({ ...defaultTestEnv }),
}));
vi.mock('../lib/prisma.js', () => ({
	prisma: {
		get $queryRaw() { return queryRawMock; },
	},
}));
vi.mock('../lib/storage.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../lib/storage.js')>();
	return { ...actual, headObject: headObjectMock };
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

describe('health endpoints', () => {
	let app: FastifyInstance;

	beforeAll(async () => {
		const { buildApp } = await import('../app.js');
		app = await buildApp();
		await app.ready();
	});

	afterAll(async () => {
		await app.close();
	});

	beforeEach(() => {
		// Reset to default implementations so one test's mockRejectedValueOnce doesn't
		// leak into the next (tests inject a fresh failure as needed).
		headObjectMock.mockReset().mockResolvedValue(null);
		queryRawMock.mockReset().mockResolvedValue([{ '?column?': 1 }]);
	});

	it('/api/health does not probe S3 even when S3 is down', async () => {
		headObjectMock.mockRejectedValue(new Error('S3 down'));
		const res = await app.inject({ method: 'GET', url: '/api/health' });
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.ok).toBe(true);
		expect(body.checks).toEqual({ db: 'ok' });
		expect(body.checks.s3).toBeUndefined();
	});

	it('/api/health returns 503 when DB fails', async () => {
		queryRawMock.mockRejectedValue(new Error('pg down'));
		const res = await app.inject({ method: 'GET', url: '/api/health' });
		expect(res.statusCode).toBe(503);
		const body = JSON.parse(res.body);
		expect(body.ok).toBe(false);
		expect(body.checks.db).toBe('fail');
	});

	it('/api/health/deep returns 503 when S3 fails (DB ok)', async () => {
		headObjectMock.mockRejectedValue(new Error('S3 down'));
		const res = await app.inject({ method: 'GET', url: '/api/health/deep' });
		expect(res.statusCode).toBe(503);
		const body = JSON.parse(res.body);
		expect(body.ok).toBe(false);
		expect(body.checks.db).toBe('ok');
		expect(body.checks.s3).toBe('fail');
	});

	it('/api/health/deep returns 200 when both checks succeed', async () => {
		const res = await app.inject({ method: 'GET', url: '/api/health/deep' });
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.ok).toBe(true);
		expect(body.checks).toEqual({ db: 'ok', s3: 'ok' });
	});
});
