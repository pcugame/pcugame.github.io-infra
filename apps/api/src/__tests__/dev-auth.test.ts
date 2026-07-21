import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { BackendContext } from '../backend-context.js';
import type { Env } from '../config/env.js';
import { defaultTestEnv } from './helpers/app-mocks.js';

const mocks = vi.hoisted(() => ({
	envOverrides: {
		NODE_ENV: 'test',
		DEV_AUTH_ENABLED: true,
	},
	upsertDevUser: vi.fn(),
	createSession: vi.fn(),
	deleteSession: vi.fn(),
	touchSession: vi.fn(),
	authSessionFindUnique: vi.fn(),
	authSessionDelete: vi.fn(),
	bannedIpFindMany: vi.fn(),
	queryRaw: vi.fn(),
	log: {
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		child: vi.fn(),
	},
}));

vi.mock('../config/env.js', async () => {
	const { defaultTestEnv } = await import('./helpers/app-mocks.js');
	return {
		env: () => ({ ...defaultTestEnv, ...mocks.envOverrides }),
		loadEnv: () => ({ ...defaultTestEnv, ...mocks.envOverrides }),
	};
});

vi.mock('../lib/logger.js', () => ({
	logger: () => mocks.log,
	rootLogger: () => mocks.log,
	createRootLogger: () => mocks.log,
}));

vi.mock('../lib/prisma.js', () => ({
	prisma: {
		get $queryRaw() { return mocks.queryRaw; },
		authSession: {
			findUnique: mocks.authSessionFindUnique,
			delete: mocks.authSessionDelete,
		},
		bannedIp: {
			findMany: mocks.bannedIpFindMany,
		},
	},
}));

vi.mock('../modules/auth/repository.js', () => ({
	findSessionWithUser: mocks.authSessionFindUnique,
	upsertUserByGoogleSub: vi.fn(),
	upsertDevUser: mocks.upsertDevUser,
	createSession: mocks.createSession,
	deleteSession: mocks.deleteSession,
	touchSession: mocks.touchSession,
}));

const emptyRoute = async () => {};

function currentConfig(): Env {
	return {
		...defaultTestEnv,
		...mocks.envOverrides,
		NODE_ENV: mocks.envOverrides.NODE_ENV as Env['NODE_ENV'],
		LOG_LEVEL: 'info',
		GOOGLE_CLIENT_IDS: [...defaultTestEnv.GOOGLE_CLIENT_IDS],
		CORS_ALLOWED_ORIGINS: [...defaultTestEnv.CORS_ALLOWED_ORIGINS],
	};
}

async function createDevAuthTestContext(): Promise<BackendContext> {
	const { devAuthController } = await import('../modules/dev-auth/controller.js');
	const config = currentConfig();
	let state: ReturnType<BackendContext['lifecycle']['state']> = 'ready';
	let inFlight = 0;
	let requestId = 0;
	let closePromise: Promise<void> | undefined;
	const logger = {
		...mocks.log,
		trace: vi.fn(),
		fatal: vi.fn(),
	};
	mocks.log.child.mockReturnValue(logger);

	return {
		config,
		clock: { now: () => new Date('2026-07-21T00:00:00.000Z') },
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
			createMultipart: async () => 'upload-id',
			uploadPart: async () => 'etag',
			completeMultipart: async () => {},
			abortMultipart: async () => {},
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
		exportProgress: {} as BackendContext['exportProgress'],
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
			find: mocks.authSessionFindUnique,
			touch: mocks.touchSession,
			delete: mocks.authSessionDelete,
		},
		maintenance: {
			recoverStaleUploads: async () => {},
			purgeExpiredSessions: async () => 0,
			reapOrphans: async () => {},
		},
		routes: {
			auth: emptyRoute,
			devAuth: devAuthController,
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

async function buildDevAuthTestApp(): Promise<FastifyInstance> {
	const [{ buildApp }, context] = await Promise.all([
		import('../app.js'),
		createDevAuthTestContext(),
	]);
	return buildApp({ context });
}

describe('dev auth routes', () => {
	let app: FastifyInstance | undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.envOverrides.NODE_ENV = 'test';
		mocks.envOverrides.DEV_AUTH_ENABLED = true;
		mocks.log.child.mockReturnValue(mocks.log);
		mocks.authSessionFindUnique.mockResolvedValue(null);
		mocks.authSessionDelete.mockResolvedValue({});
		mocks.bannedIpFindMany.mockResolvedValue([]);
		mocks.queryRaw.mockResolvedValue([{ '?column?': 1 }]);
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
		app = await buildDevAuthTestApp();
		await app.ready();

		const res = await app.inject({
			method: 'POST',
			url: '/api/dev/auth/login',
			headers: { origin: 'http://localhost:5173' },
			payload: { role: 'ADMIN' },
		});

		expect(res.statusCode).toBe(200);
		expect(res.headers['set-cookie']).toEqual(expect.stringContaining('sid='));
		expect(mocks.upsertDevUser).toHaveBeenCalledWith(expect.objectContaining({
			email: 'admin@test.pcu.ac.kr',
			role: 'ADMIN',
		}));
		expect(mocks.createSession).toHaveBeenCalledWith(expect.objectContaining({
			userId: 10,
			expiresAt: expect.any(Date),
		}));
		expect(JSON.parse(res.body)).toMatchObject({
			ok: true,
			data: {
				user: {
					email: 'admin@test.pcu.ac.kr',
					role: 'ADMIN',
				},
			},
		});
	});

	it.each([
		['domain-not-allowed', 403, 'EMAIL_DOMAIN_NOT_ALLOWED'],
		['google-api-unavailable', 401, 'GOOGLE_API_UNAVAILABLE'],
		['invalid-google-token', 401, 'UNAUTHORIZED'],
		['missing-google-payload', 401, 'UNAUTHORIZED'],
		['api-server-error', 500, 'INTERNAL_ERROR'],
	])('returns the simulated %s login failure through the API error envelope', async (scenario, status, code) => {
		app = await buildDevAuthTestApp();
		await app.ready();

		const res = await app.inject({
			method: 'POST',
			url: '/api/dev/auth/login-error',
			headers: { origin: 'http://localhost:5173' },
			payload: { scenario },
		});

		expect(res.statusCode).toBe(status);
		expect(JSON.parse(res.body)).toMatchObject({
			ok: false,
			error: { code },
		});
	});

	it('does not register dev auth routes in production even when enabled', async () => {
		mocks.envOverrides.NODE_ENV = 'production';
		mocks.envOverrides.DEV_AUTH_ENABLED = true;
		app = await buildDevAuthTestApp();
		await app.ready();

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
