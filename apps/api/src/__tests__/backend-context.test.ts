import { Readable, Writable } from 'node:stream';
import type { FastifyPluginAsync } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { BackendContext } from '../backend-context.js';
import type { Env } from '../config/env.js';
import { buildApp } from '../app.js';
import { defaultTestEnv } from './helpers/app-mocks.js';

function testConfig(): Env {
	return {
		...defaultTestEnv,
		LOG_LEVEL: 'info',
		GOOGLE_CLIENT_IDS: [...defaultTestEnv.GOOGLE_CLIENT_IDS],
		CORS_ALLOWED_ORIGINS: [...defaultTestEnv.CORS_ALLOWED_ORIGINS],
	};
}

function createTestContext(): {
	context: BackendContext;
	storageHead: ReturnType<typeof vi.fn>;
	resourceClose: ReturnType<typeof vi.fn>;
	authSessionFind: ReturnType<typeof vi.fn>;
	authSessionTouch: ReturnType<typeof vi.fn>;
} {
	const storageHead = vi.fn().mockResolvedValue({ size: 0, contentType: 'text/plain' });
	const resourceClose = vi.fn();
	const authSessionFind = vi.fn().mockResolvedValue(null);
	const authSessionTouch = vi.fn().mockResolvedValue(undefined);
	let inFlight = 0;
	let requestSequence = 0;
	const emptyRoutes: FastifyPluginAsync = async () => {};
	const testLogger: BackendContext['logger'] = {
		child: () => testLogger,
		trace: () => {},
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
		fatal: () => {},
	};
	const authRoutes: FastifyPluginAsync = async (app) => {
		app.post('/auth/google', async () => ({ ok: true }));
		app.get('/session-user', async (request) => ({ user: request.currentUser ?? null }));
	};

	return {
		context: {
			config: testConfig(),
			clock: { now: () => new Date('2026-07-21T05:00:00.000Z') },
			logger: testLogger,
			ids: { next: () => `request-${++requestSequence}` },
			storage: {
				upload: async () => {},
				presign: async () => 'https://storage.test/object',
				delete: async () => {},
				head: storageHead,
				readRange: async () => Buffer.alloc(0),
				stream: async () => null,
				listKeys: async () => [],
				createMultipart: async () => 'upload-id',
				uploadPart: async () => 'etag',
				completeMultipart: async () => {},
				abortMultipart: async () => {},
			},
			fileSystem: {
				temporaryDirectory: () => '/tmp',
				stat: async () => ({ size: 0 }),
				access: async () => {},
				mkdir: async () => {},
				rename: async () => {},
				remove: async () => {},
				createReadStream: () => Readable.from([]),
				createWriteStream: () => new Writable({ write(_chunk, _encoding, done) { done(); } }),
			},
			googleTokens: { verify: async () => undefined },
			scheduler: { every: () => ({ cancel: () => {} }) },
			uploadLimiter: { acquire: () => {}, release: () => {} },
			settings: {
				get: async () => ({ maxGameFileMb: 5120, maxChunkSizeMb: 10 }),
				update: async (value) => ({
					maxGameFileMb: value.maxGameFileMb ?? 5120,
					maxChunkSizeMb: value.maxChunkSizeMb ?? 10,
				}),
				invalidate: () => {},
			},
			lifecycle: {
				state: () => 'ready',
				setState: () => {},
				isAcceptingNewWork: () => true,
				requestStarted: () => { inFlight++; },
				requestFinished: () => { inFlight--; },
				inFlight: () => inFlight,
				waitForDrain: async () => 'drained',
			},
			databaseHealth: { check: async () => true, close: async () => {} },
			authSessions: {
				find: authSessionFind,
				touch: authSessionTouch,
				delete: async () => {},
			},
			maintenance: {
				recoverStaleUploads: async () => {},
				purgeExpiredSessions: async () => 0,
				reapOrphans: async () => {},
			},
			shutdownResources: [{ close: resourceClose }],
			routes: {
				auth: authRoutes,
				devAuth: emptyRoutes,
				public: emptyRoutes,
				admin: emptyRoutes,
				me: emptyRoutes,
				assets: emptyRoutes,
			},
		},
		storageHead,
		resourceClose,
		authSessionFind,
		authSessionTouch,
	};
}

describe('BackendContext composition', () => {
	it('runs health checks with injected clock, request IDs, DB, and storage ports', async () => {
		const { context, storageHead, resourceClose } = createTestContext();
		const app = await buildApp({ context });
		try {
			const shallow = await app.inject({ method: 'GET', url: '/api/health' });
			expect(shallow.statusCode).toBe(200);
			expect(shallow.headers['x-request-id']).toBe('request-1');
			expect(shallow.json()).toMatchObject({
				ok: true,
				state: 'ready',
				timestamp: '2026-07-21T05:00:00.000Z',
				checks: { db: 'ok' },
			});
			expect(storageHead).not.toHaveBeenCalled();

			const deep = await app.inject({ method: 'GET', url: '/api/health/deep' });
			expect(deep.statusCode).toBe(200);
			expect(storageHead).toHaveBeenCalledWith('pcu-public', '.healthcheck');
			expect(context.lifecycle.inFlight()).toBe(0);
		} finally {
			await app.close();
		}
		expect(resourceClose).toHaveBeenCalledOnce();
	});

	it('validates JSON commands at the route boundary before the handler runs', async () => {
		const { context } = createTestContext();
		const app = await buildApp({ context });
		try {
			const response = await app.inject({
				method: 'POST',
				url: '/api/auth/google',
				headers: { origin: 'http://localhost:5173' },
				payload: {},
			});
			expect(response.statusCode).toBe(400);
			expect(response.json()).toMatchObject({
				ok: false,
				error: { code: 'VALIDATION_ERROR', message: 'Validation failed' },
			});
		} finally {
			await app.close();
		}
	});

	it('uses the injected session store and does not extend a cookie when touch persistence fails', async () => {
		const { context, authSessionFind, authSessionTouch } = createTestContext();
		authSessionFind.mockResolvedValue({
			id: 'session-1',
			expiresAt: new Date('2026-07-22T05:00:00.000Z'),
			lastSeenAt: new Date('2026-07-21T04:00:00.000Z'),
			user: {
				id: 9,
				googleSub: 'subject',
				email: 'student@g.pcu.ac.kr',
				name: 'Student',
				role: 'USER',
				studentId: '20260001',
			},
		});
		authSessionTouch.mockRejectedValue(new Error('database unavailable'));
		const app = await buildApp({ context });
		try {
			const response = await app.inject({
				method: 'GET',
				url: '/api/session-user',
				headers: {
					origin: 'http://localhost:5173',
					cookie: 'sid=session-1',
				},
			});
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({ user: { id: 9, role: 'USER' } });
			expect(authSessionFind).toHaveBeenCalledWith('session-1');
			expect(authSessionTouch).toHaveBeenCalledWith(
				'session-1',
				new Date('2026-07-21T05:00:00.000Z'),
			);
			expect(response.headers['set-cookie']).toBeUndefined();
		} finally {
			await app.close();
		}
	});
});
