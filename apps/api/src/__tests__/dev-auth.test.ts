import { createConnection } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { BackendContext } from '../backend-context.js';
import type { Env } from '../config/env.js';
import { buildApp } from '../app.js';
import { createAuthService } from '../modules/auth/service.js';
import { createDevAuthController } from '../modules/dev-auth/controller.js';
import { defaultTestEnv } from './helpers/app-mocks.js';
import { createTestUploadLifecycleRuntime } from './helpers/upload-lifecycle.js';

const mocks = {
	upsertDevUser: vi.fn(),
	createSession: vi.fn(),
	deleteSession: vi.fn(),
	touchSession: vi.fn(),
	findSession: vi.fn(),
};

const emptyRoute: FastifyPluginAsync = async () => {};

function config(overrides: Partial<Env> = {}): Env {
	return {
		...defaultTestEnv,
		LOG_LEVEL: 'info',
		DEV_AUTH_ENABLED: true,
		GOOGLE_CLIENT_IDS: [...defaultTestEnv.GOOGLE_CLIENT_IDS],
		CORS_ALLOWED_ORIGINS: [...defaultTestEnv.CORS_ALLOWED_ORIGINS],
		...overrides,
	};
}

function createDevAuthTestContext(cfg = config()): BackendContext {
	const clock = { now: () => new Date('2026-07-21T00:00:00.000Z') };
	const logger: BackendContext['logger'] = {
		child: () => logger,
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		fatal: vi.fn(),
	};
	const uploadLifecycle = createTestUploadLifecycleRuntime();
	const service = createAuthService({
		repository: {
			upsertUserByGoogleSub: vi.fn(),
			upsertDevUser: mocks.upsertDevUser,
			createSession: mocks.createSession,
			delete: mocks.deleteSession,
		},
		googleTokens: { verify: async () => undefined },
		clock,
		ids: { next: () => 'dev-session-id' },
		sessionAbsoluteMs: cfg.SESSION_ABSOLUTE_MS,
		googleClientIds: cfg.GOOGLE_CLIENT_IDS,
		allowedGoogleHostedDomain: cfg.ALLOWED_GOOGLE_HD,
		logger,
	});
	let state: ReturnType<BackendContext['lifecycle']['state']> = 'ready';
	let inFlight = 0;
	let requestId = 0;
	let closePromise: Promise<void> | undefined;

	return {
		config: cfg,
		clock,
		logger,
		ids: { next: () => `dev-auth-request-${++requestId}` },
		storage: {
			upload: async () => {},
			presign: async () => 'https://storage.test/object',
			delete: async () => {},
			head: async () => null,
			readRange: async () => Buffer.alloc(0),
			stream: async () => null,
			listKeys: async () => [],
			listKeyPage: async () => ({ keys: [], isTruncated: false }),
			deleteKeys: async (_bucket, keys) => ({ deleted: [...keys], failures: [] }),
			createMultipart: async () => 'upload-id',
			uploadPart: async () => 'etag',
			completeMultipart: async () => {},
			abortMultipart: async () => {},
			listParts: async () => [],
			listMultipartUploads: async () => [],
		},
		fileSystem: {} as BackendContext['fileSystem'],
		googleTokens: { verify: async () => undefined },
		scheduler: {
			every: () => ({ cancel: () => {} }),
			delay: async () => {},
		},
		uploadLimiter: { acquire: () => {}, release: () => {} },
		protectedDownloads: {} as BackendContext['protectedDownloads'],
		settings: {
			get: async () => ({ maxGameFileMb: 5120, maxChunkSizeMb: 10 }),
			update: async (patch) => ({
				maxGameFileMb: patch.maxGameFileMb ?? 5120,
				maxChunkSizeMb: patch.maxChunkSizeMb ?? 10,
			}),
			invalidate: () => {},
		},
		uploadLifecycleMetrics: {
			recordPostCommitCleanupFailure: () => {},
			postCommitCleanupFailureCount: () => 0,
			recordUntrackedMultipartCleanupFailure: () => {},
			untrackedMultipartCleanupFailureCount: () => 0,
		},
		uploadLifecycle,
		lifecycle: {
			state: () => state,
			setState: (next) => { state = next; },
			isAcceptingNewWork: () => true,
			requestStarted: () => { inFlight++; },
			requestFinished: () => { inFlight--; },
			inFlight: () => inFlight,
			waitForDrain: async () => 'drained',
		},
		databaseHealth: { check: async () => true },
		authSessions: {
			find: mocks.findSession,
			touch: mocks.touchSession,
			delete: mocks.deleteSession,
		},
		maintenance: {
			recoverStaleUploads: async () => {},
			purgeExpiredSessions: async () => 0,
			reapOrphans: async () => {},
		},
		routes: {
			auth: emptyRoute,
			devAuth: createDevAuthController({ config: cfg, clock, service }),
			public: emptyRoute,
			admin: emptyRoute,
			me: emptyRoute,
			assets: emptyRoute,
		},
		resourceOwnership: [],
		start: async () => {},
		close: () => {
			closePromise ??= Promise.resolve();
			return closePromise;
		},
	};
}

describe('dev auth routes', () => {
	let app: FastifyInstance | undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findSession.mockResolvedValue(null);
		mocks.deleteSession.mockResolvedValue({});
		mocks.createSession.mockResolvedValue({});
		mocks.upsertDevUser.mockImplementation(async (data) => ({
			id: 10,
			email: data.email,
			name: data.name,
			role: data.role,
			studentId: data.studentId ?? null,
		}));
	});

	afterEach(async () => {
		if (app) {
			await app.close();
			app = undefined;
		}
	});

	it('creates a real session cookie for a fixed dev role', async () => {
		app = await buildApp({ context: createDevAuthTestContext() });

		const res = await app.inject({
			method: 'POST',
			url: '/api/dev/auth/login',
			headers: { origin: 'http://localhost:5173' },
			payload: { role: 'ADMIN' },
		});

		expect(res.statusCode).toBe(200);
		expect(res.headers['set-cookie']).toContain('sid=dev-session-id');
		expect(mocks.upsertDevUser).toHaveBeenCalledWith(expect.objectContaining({
			email: 'admin@test.pcu.ac.kr',
			role: 'ADMIN',
		}));
		expect(mocks.createSession).toHaveBeenCalledWith({
			id: 'dev-session-id',
			userId: 10,
			expiresAt: new Date('2026-08-04T00:00:00.000Z'),
		});
		expect(res.json()).toMatchObject({
			ok: true,
			data: { user: { email: 'admin@test.pcu.ac.kr', role: 'ADMIN' } },
		});
	});

	it('accounts for an aborted request body exactly once over a real TCP socket', async () => {
		const context = createDevAuthTestContext();
		app = await buildApp({ context });
		await app.listen({ host: '127.0.0.1', port: 0 });
		const address = app.server.address();
		if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
		const socket = createConnection({ host: '127.0.0.1', port: address.port });
		socket.on('error', () => {});
		let received = '';
		socket.on('data', (chunk) => { received += chunk.toString(); });
		await new Promise<void>((resolve) => socket.once('connect', resolve));
		await new Promise<void>((resolve, reject) => socket.write([
			'POST /api/dev/auth/login HTTP/1.1',
			'Host: 127.0.0.1',
			'Origin: http://localhost:5173',
			'Content-Type: application/json',
			'Content-Length: 100',
			'Connection: close',
			'',
			'{',
		].join('\r\n'), (error) => error ? reject(error) : resolve()));
		await vi.waitFor(() => expect({
			inFlight: context.lifecycle.inFlight(),
			received,
		}).toEqual({ inFlight: 1, received: '' }));
		socket.destroy();
		await vi.waitFor(() => expect(context.lifecycle.inFlight()).toBe(0));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(context.lifecycle.inFlight()).toBe(0);
	});

	it('closes an idle keep-alive connection when Fastify closes', async () => {
		const context = createDevAuthTestContext();
		app = await buildApp({ context });
		await app.listen({ host: '127.0.0.1', port: 0 });
		const address = app.server.address();
		if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
		const socket = createConnection({ host: '127.0.0.1', port: address.port });
		socket.on('error', () => {});
		await new Promise<void>((resolve) => socket.once('connect', resolve));
		const response = new Promise<string>((resolve) => {
			let received = '';
			socket.on('data', (chunk) => {
				received += chunk.toString();
				if (received.includes('"ok":true')) resolve(received);
			});
		});
		socket.write([
			'GET /api/health HTTP/1.1',
			'Host: 127.0.0.1',
			'Connection: keep-alive',
			'',
			'',
		].join('\r\n'));
		await expect(response).resolves.toContain('200 OK');
		const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
		await app.close();
		await closed;
		expect(context.lifecycle.inFlight()).toBe(0);
		app = undefined;
	});

	it.each([
		['domain-not-allowed', 403, 'EMAIL_DOMAIN_NOT_ALLOWED'],
		['google-api-unavailable', 401, 'GOOGLE_API_UNAVAILABLE'],
		['invalid-google-token', 401, 'UNAUTHORIZED'],
		['missing-google-payload', 401, 'UNAUTHORIZED'],
		['api-server-error', 500, 'INTERNAL_ERROR'],
	])('returns the simulated %s login failure through the API error envelope', async (scenario, status, code) => {
		app = await buildApp({ context: createDevAuthTestContext() });
		const res = await app.inject({
			method: 'POST',
			url: '/api/dev/auth/login-error',
			headers: { origin: 'http://localhost:5173' },
			payload: { scenario },
		});
		expect(res.statusCode).toBe(status);
		expect(res.json()).toMatchObject({ ok: false, error: { code } });
	});

	it('uses explicit config to omit dev auth in production even when enabled', async () => {
		app = await buildApp({
			context: createDevAuthTestContext(config({ NODE_ENV: 'production', DEV_AUTH_ENABLED: true })),
		});
		const res = await app.inject({
			method: 'POST',
			url: '/api/dev/auth/login',
			headers: { origin: 'http://localhost:5173' },
			payload: { role: 'ADMIN' },
		});
		expect(res.statusCode).toBe(404);
		expect(mocks.upsertDevUser).not.toHaveBeenCalled();
	});
});
