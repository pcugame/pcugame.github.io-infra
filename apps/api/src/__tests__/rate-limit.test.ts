import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { Readable, Writable } from 'node:stream';
import { defaultTestEnv } from './helpers/app-mocks.js';
import type { BackendContext } from '../backend-context.js';
import { createTestUploadLifecycleRuntime } from './helpers/upload-lifecycle.js';
import { createUploadLifecycleMetrics } from '../lib/upload-lifecycle-metrics.js';
import { createProtectedDownloadLimiter } from '../shared/protected-download-limiter.js';
import {
	DirectControlPrincipalLimiter,
	GLOBAL_IP_ABUSE_CEILING_MIN,
	directUploadSessionId,
	globalIpAbuseCeiling,
	isCanonicalAssetDownload,
	isDirectUploadControl,
} from '../plugins/rate-limit.js';

// Use very tight limits so the test doesn't need to send 300+ requests.
const testEnv = {
	...defaultTestEnv,
	TRUST_PROXY: '1',
	RATE_LIMIT_GLOBAL_MAX: 5,
	RATE_LIMIT_GLOBAL_WINDOW_MS: 60_000,
	RATE_LIMIT_LOGIN_MAX: 3,
	RATE_LIMIT_LOGIN_WINDOW_MS: 60_000,
};

vi.mock('../config/env.js', () => ({
	loadEnv: () => ({ ...testEnv }),
}));
vi.mock('../shared/protected-download-limiter.js', () => {
	const limiter = {
		start: vi.fn(),
		check: vi.fn().mockReturnValue('ok'),
		isBanned: vi.fn().mockReturnValue(false),
		addBan: vi.fn(),
		removeBan: vi.fn(),
		loadBannedIps: vi.fn(),
		close: vi.fn(),
		destroy: vi.fn(),
	};
	return {
		createProtectedDownloadLimiter: () => limiter,
	};
});
describe('rate-limit plugin', () => {
	let app: FastifyInstance;
	let requestSequence = 0;
	const emptyRoute: FastifyPluginAsync = async () => {};
	const authRoute: FastifyPluginAsync = async (instance) => {
		instance.post('/auth/google', {
			config: {
				rateLimit: {
					max: testEnv.RATE_LIMIT_LOGIN_MAX,
					timeWindow: testEnv.RATE_LIMIT_LOGIN_WINDOW_MS,
				},
			},
		}, async () => ({ ok: false }));
		instance.get('/me', async () => ({ ok: true, data: { authenticated: false } }));
	};
	const logger: BackendContext['logger'] = {
		child: () => logger,
		trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
	};
	const context: BackendContext = {
		config: {
			...testEnv,
			LOG_LEVEL: 'info',
			GOOGLE_CLIENT_IDS: [...testEnv.GOOGLE_CLIENT_IDS],
			CORS_ALLOWED_ORIGINS: [...testEnv.CORS_ALLOWED_ORIGINS],
		},
		clock: { now: () => new Date('2026-08-11T00:00:00.000Z') },
		logger,
		ids: { next: () => `rate-limit-${++requestSequence}` },
		storage: {
			upload: async () => {}, presign: async () => '', delete: async () => {},
			head: async () => null, readRange: async () => Buffer.alloc(0), stream: async () => null,
			listKeys: async () => [], listKeyPage: async () => ({ keys: [], isTruncated: false }),
			deleteKeys: async (_bucket, keys) => ({ deleted: [...keys], failures: [] }),
			createMultipart: async () => '', uploadPart: async () => '',
			completeMultipart: async () => {}, abortMultipart: async () => {}, listParts: async () => [],
			listMultipartUploads: async () => [],
		},
		fileSystem: {
			temporaryDirectory: () => '/tmp', stat: async () => ({ size: 0 }), access: async () => {},
			mkdir: async () => {}, rename: async () => {}, remove: async () => {},
			readRange: async () => Buffer.alloc(0), createReadStream: () => Readable.from([]),
			createWriteStream: () => new Writable({ write(_chunk, _encoding, done) { done(); } }),
		},
		googleTokens: { verify: async () => undefined },
		scheduler: { every: () => ({ cancel: () => {} }), delay: async () => {} },
		uploadLimiter: { acquire: () => {}, release: () => {} },
		protectedDownloads: createProtectedDownloadLimiter(),
		settings: {
			get: async () => ({ maxGameFileMb: 5120, maxChunkSizeMb: 10 }),
			update: async () => ({ maxGameFileMb: 5120, maxChunkSizeMb: 10 }),
			invalidate: () => {},
		},
		uploadLifecycleMetrics: createUploadLifecycleMetrics(),
		uploadLifecycle: createTestUploadLifecycleRuntime(),
		lifecycle: {
			state: () => 'ready', setState: () => {}, isAcceptingNewWork: () => true,
			requestStarted: () => {}, requestFinished: () => {}, inFlight: () => 0,
			waitForDrain: async () => 'drained',
		},
		databaseHealth: { check: async () => true },
		authSessions: { find: async () => null, touch: async () => {}, delete: async () => {} },
		maintenance: {
			recoverStaleUploads: async () => {}, purgeExpiredSessions: async () => 0,
			reapOrphans: async () => {},
		},
		routes: {
			auth: authRoute, devAuth: emptyRoute, public: emptyRoute, admin: emptyRoute,
			me: emptyRoute, assets: emptyRoute,
		},
		resourceOwnership: [], start: async () => {}, close: async () => {},
	};

	beforeAll(async () => {
		const { buildApp } = await import('../app.js');
		app = await buildApp({ context });
		await app.ready();
	});

	afterAll(async () => {
		await app.close();
	});

	const clientIp = '203.0.113.7';

	it('treats the global IP limit as a high abuse ceiling', async () => {
		expect(globalIpAbuseCeiling(5)).toBe(GLOBAL_IP_ABUSE_CEILING_MIN);
		for (let i = 0; i < 7; i++) {
			const response = await app.inject({ method: 'GET', url: '/api/me', remoteAddress: clientIp });
			expect(response.statusCode).toBe(200);
		}
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
		// The first three requests reach the handler (the fake token is rejected),
		// then the tighter route bucket short-circuits a later request.
		expect(codes.slice(0, 3).every((c) => c !== 429)).toBe(true);
		expect(codes.slice(3).some((c) => c === 429)).toBe(true);
	});

	it('accepts the forwarded client IP behind the single trusted nginx hop without making NAT the normal quota', async () => {
		const proxyAddress = '127.0.0.1';
		const firstClientCodes: number[] = [];
		for (let i = 0; i < 7; i++) {
			const response = await app.inject({
				method: 'GET',
				url: '/api/me',
				remoteAddress: proxyAddress,
				headers: { 'x-forwarded-for': '198.51.100.10' },
			});
			firstClientCodes.push(response.statusCode);
		}

		expect(firstClientCodes).not.toContain(429);
		const independentClient = await app.inject({
			method: 'GET',
			url: '/api/me',
			remoteAddress: proxyAddress,
			headers: { 'x-forwarded-for': '198.51.100.11' },
		});
		expect(independentClient.statusCode).toBe(200);
	});

	it('allows 50 authenticated principals behind one NAT and isolates actor/session abuse', () => {
		let now = 0;
		const limiter = new DirectControlPrincipalLimiter(60_000, 600, 240, () => now);
		const natIp = '198.51.100.50';
		for (let actorId = 1; actorId <= 50; actorId++) {
			const sessionId = `session-${actorId}`;
			// create + 40 eight-part URL batches + polls + refreshes + complete + download
			// stays well below the 5,000 request IP abuse ceiling as an aggregate.
			expect(limiter.check(actorId), `${natIp} actor ${actorId} create`).toEqual({ allowed: true });
			for (let request = 0; request < 55; request += 1) {
				expect(limiter.check(actorId, sessionId), `${natIp} actor ${actorId} request ${request}`)
					.toEqual({ allowed: true });
			}
		}
		expect(50 * 56).toBeLessThan(GLOBAL_IP_ABUSE_CEILING_MIN);
		for (let request = 0; request < 240; request += 1) {
			expect(limiter.check(999, 'hot-session')).toEqual({ allowed: true });
		}
		expect(limiter.check(999, 'hot-session')).toEqual({ allowed: false, retryAfterSec: 60 });
		expect(limiter.check(2, 'independent-session')).toEqual({ allowed: true });
		now = 60_000;
		expect(limiter.check(999, 'hot-session')).toEqual({ allowed: true });
	});

	it('allowlists only the canonical assetId download route from the global IP bucket', () => {
		expect(isCanonicalAssetDownload('/api/assets/42/download')).toBe(true);
		expect(isCanonicalAssetDownload('/api/assets/42/download?variant=playback')).toBe(true);
		expect(isCanonicalAssetDownload('/api/assets/protected/legacy.zip')).toBe(false);
		expect(isCanonicalAssetDownload('/api/assets/42')).toBe(false);
	});

	it.each([
		['create project poster', '/api/admin/projects/12/direct-poster-upload-sessions', undefined],
		['create exhibition poster', '/api/admin/exhibitions/12/direct-poster-upload-sessions', undefined],
		['status', '/api/admin/direct-asset-upload-sessions/session-12', 'session-12'],
		['part URL refresh', '/api/admin/direct-asset-upload-sessions/session-12/part-urls', 'session-12'],
		['completion', '/api/admin/direct-asset-upload-sessions/session-12/complete?generation=3', 'session-12'],
		['cancellation', '/api/admin/direct-asset-upload-sessions/session-12', 'session-12'],
	])('recognizes deployed /api/admin direct control path: %s', (_label, path, sessionId) => {
		expect(isDirectUploadControl(path)).toBe(true);
		expect(directUploadSessionId(path)).toBe(sessionId);
	});

	it.each([
		'/api/admin/exhibitions/12/poster',
		'/api/admin/projects/12/assets',
		'/api/admin/direct-asset-upload-sessions',
		'/api/direct-asset-upload-sessions/session-12/unknown',
	])('does not classify non-control route as direct control: %s', (path) => {
		expect(isDirectUploadControl(path)).toBe(false);
	});

	it.each(['/api/health', '/api/health/deep'])(
		'exempts %s from the rate limiter while preserving the healthy response contract',
		async (url) => {
			const healthIp = '203.0.113.9';
			for (let i = 0; i < 10; i++) {
				const res = await app.inject({ method: 'GET', url, remoteAddress: healthIp });
				expect(res.statusCode).toBe(200);
				expect(res.json()).toEqual({
					ok: true,
					state: 'ready',
					timestamp: '2026-08-11T00:00:00.000Z',
					checks: url.endsWith('/deep') ? { db: 'ok', s3: 'ok' } : { db: 'ok' },
				});
			}
		},
	);
});
