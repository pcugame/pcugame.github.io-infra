import { readFile } from 'node:fs/promises';
import type { S3Client } from '@aws-sdk/client-s3';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppLogger, ObjectStorage, Scheduler } from '../application/ports.js';
import { buildApp } from '../app.js';
import {
	createProductionBackendContext,
	type BackendRoutes,
} from '../backend-context.js';
import type { Env } from '../config/env.js';
import type { AuthProductionRepository } from '../modules/auth/composition.js';
import { defaultTestEnv } from './helpers/app-mocks.js';
import { createScriptedBackendPersistence } from './helpers/backend-persistence.js';
import { ownedTestUploadLifecycleResource } from './helpers/upload-lifecycle.js';

const emptyRoute: FastifyPluginAsync = async () => {};
const origin = 'http://localhost:5173';

function config(label: string, overrides: Partial<Env> = {}): Env {
	return {
		...defaultTestEnv,
		LOG_LEVEL: 'info',
		SESSION_COOKIE_NAME: `${label}-sid`,
		GOOGLE_CLIENT_IDS: [`${label}-client-id`],
		ALLOWED_GOOGLE_HD: `${label}.example.edu`,
		CORS_ALLOWED_ORIGINS: [origin],
		...overrides,
	};
}

function storage(): ObjectStorage {
	return {
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
		listParts: async () => [],
		listMultipartUploads: async () => [],
	};
}

function loggerHarness() {
	const calls = {
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		fatal: vi.fn(),
	};
	const logger: AppLogger = {
		child: () => logger,
		...calls,
	};
	return { logger, calls };
}

type Session = {
	id: string;
	expiresAt: Date;
	lastSeenAt: Date;
	user: {
		id: number;
		googleSub: string;
		email: string;
		name: string;
		role: 'USER' | 'OPERATOR' | 'ADMIN';
		studentId: string | null;
	};
};

function repositoryHarness(label: string, now: Date) {
	const sessions = new Map<string, Session>();
	let lastUser: Session['user'] | undefined;
	const calls = {
		userUpsert: vi.fn(async (data: {
			googleSub: string;
			email: string;
			name: string;
			picture?: string;
			role?: Session['user']['role'];
			studentId?: string | null;
		}) => {
			lastUser = {
				id: label.charCodeAt(0),
				googleSub: data.googleSub,
				email: data.email,
				name: data.name,
				role: data.role ?? 'USER',
				studentId: data.studentId ?? null,
			};
			return lastUser;
		}),
		sessionCreate: vi.fn(async (data: { id: string; userId: number; expiresAt: Date }) => {
			if (!lastUser) throw new Error('user must be created first');
			const record: Session = {
				id: data.id,
				expiresAt: data.expiresAt,
				lastSeenAt: now,
				user: lastUser,
			};
			sessions.set(record.id, record);
			return record;
		}),
		sessionFind: vi.fn(async (id: string) => sessions.get(id) ?? null),
		sessionTouch: vi.fn(async (id: string, lastSeenAt: Date) => {
			const record = sessions.get(id);
			if (!record) throw new Error('missing session');
			record.lastSeenAt = lastSeenAt;
			return record;
		}),
		sessionDelete: vi.fn(async (id: string) => ({
			count: sessions.delete(id) ? 1 : 0,
		})),
	};
	const repository: AuthProductionRepository = {
		find: calls.sessionFind,
		touch: calls.sessionTouch,
		delete: calls.sessionDelete,
		purgeExpired: vi.fn(async () => 0),
		upsertUserByGoogleSub: calls.userUpsert,
		upsertDevUser: calls.userUpsert,
		createSession: calls.sessionCreate,
	};
	return { repository, sessions, calls };
}

async function authHarness(
	label: string,
	overrides: Partial<Env> = {},
	clockValue = new Date('2026-07-21T00:00:00.000Z'),
) {
	const cfg = config(label, overrides);
	const clock = { now: vi.fn(() => new Date(clockValue)) };
	const ids = {
		sequence: 0,
		next: vi.fn(() => `${label}-id-${++ids.sequence}`),
	};
	const googleTokens = {
		verify: vi.fn(async () => ({
			sub: `${label}-private-subject`,
			email: `20260001@${label}.example.edu`,
			name: `${label} Student`,
			hd: `${label}.example.edu`,
		})),
	};
	const repository = repositoryHarness(label, clockValue);
	const logs = loggerHarness();
	const scheduler: Scheduler = {
		every: vi.fn(() => ({ cancel: vi.fn() })),
		delay: vi.fn(async () => {}),
	};
	const context = await createProductionBackendContext(cfg, {
		persistence: createScriptedBackendPersistence({
			authRepository: repository.repository,
		}),
		factories: {
			routes: (_config, _assets, auth): BackendRoutes => ({
				auth: auth.authController,
				devAuth: auth.devAuthController,
				public: emptyRoute,
				admin: emptyRoute,
				me: emptyRoute,
				assets: emptyRoute,
			}),
		},
		resources: {
			uploadLifecycle: ownedTestUploadLifecycleResource(),
			logger: { value: logs.logger, ownership: 'borrowed' },
			clock: { value: clock, ownership: 'borrowed' },
			ids: { value: ids, ownership: 'borrowed' },
			scheduler: { value: scheduler, ownership: 'borrowed' },
			googleTokens: { value: googleTokens, ownership: 'borrowed' },
			s3: {
				value: { send: vi.fn(), destroy: vi.fn() } as unknown as S3Client,
				ownership: 'borrowed',
			},
			storage: { value: storage(), ownership: 'borrowed' },
			settings: {
				value: {
					get: async () => ({ maxGameFileMb: 5120, maxChunkSizeMb: 10 }),
					update: async () => ({ maxGameFileMb: 5120, maxChunkSizeMb: 10 }),
					invalidate: () => {},
				},
				ownership: 'borrowed',
			},
		},
	});
	return { cfg, context, clock, clockValue, ids, googleTokens, repository, logs, scheduler };
}

function session(label: string, overrides: Partial<Session> = {}): Session {
	return {
		id: `${label}-session`,
		expiresAt: new Date('2026-07-22T00:00:00.000Z'),
		lastSeenAt: new Date('2026-07-21T00:00:00.000Z'),
		user: {
			id: 1,
			googleSub: `${label}-subject`,
			email: `${label}@example.edu`,
			name: `${label} User`,
			role: 'USER',
			studentId: null,
		},
		...overrides,
	};
}

describe('auth production wiring', () => {
	const apps: FastifyInstance[] = [];

	afterEach(async () => {
		await Promise.allSettled(apps.splice(0).map((app) => app.close()));
	});

	it('uses one context verifier/config/clock/ID/repository for login and logout', async () => {
		const harness = await authHarness('a');
		const app = await buildApp({ context: harness.context });
		apps.push(app);

		const login = await app.inject({
			method: 'POST',
			url: '/api/auth/google',
			headers: { origin },
			payload: { credential: 'a-private-credential' },
		});
		expect(login.statusCode).toBe(200);
		expect(harness.googleTokens.verify).toHaveBeenCalledWith(
			'a-private-credential',
			['a-client-id'],
		);
		expect(harness.repository.calls.userUpsert).toHaveBeenCalledOnce();
		expect(harness.repository.calls.sessionCreate).toHaveBeenCalledWith({
			id: 'a-id-2',
			userId: 'a'.charCodeAt(0),
			expiresAt: new Date('2026-08-04T00:00:00.000Z'),
		});
		expect(login.headers['set-cookie']).toContain('a-sid=a-id-2');
		expect(login.headers['set-cookie']).toContain('Expires=Tue, 21 Jul 2026 02:00:00 GMT');

		const logout = await app.inject({
			method: 'POST',
			url: '/api/auth/logout',
			headers: { origin, cookie: 'a-sid=a-id-2' },
		});
		expect(logout.statusCode).toBe(200);
		expect(harness.repository.calls.sessionFind).toHaveBeenCalledWith('a-id-2');
		expect(harness.repository.calls.sessionDelete).toHaveBeenCalledWith('a-id-2');
		expect(logout.headers['set-cookie']).toContain('a-sid=;');
	});

	it('keeps A/B verifier, config, clock, ID, and repository graphs isolated', async () => {
		const a = await authHarness('a');
		const b = await authHarness('b', { SESSION_IDLE_MS: 60 * 60 * 1000 }, new Date('2026-07-22T00:00:00.000Z'));
		const [appA, appB] = await Promise.all([
			buildApp({ context: a.context }),
			buildApp({ context: b.context }),
		]);
		apps.push(appA, appB);

		const [loginA, loginB] = await Promise.all([
			appA.inject({ method: 'POST', url: '/api/auth/google', headers: { origin }, payload: { credential: 'token-a' } }),
			appB.inject({ method: 'POST', url: '/api/auth/google', headers: { origin }, payload: { credential: 'token-b' } }),
		]);
		expect(loginA.statusCode).toBe(200);
		expect(loginB.statusCode).toBe(200);
		expect(a.googleTokens.verify).toHaveBeenCalledWith('token-a', ['a-client-id']);
		expect(a.googleTokens.verify).not.toHaveBeenCalledWith('token-b', expect.anything());
		expect(b.googleTokens.verify).toHaveBeenCalledWith('token-b', ['b-client-id']);
		expect(a.repository.sessions.has('a-id-2')).toBe(true);
		expect(a.repository.sessions.has('b-id-2')).toBe(false);
		expect(b.repository.sessions.has('b-id-2')).toBe(true);
		expect(loginA.headers['set-cookie']).toContain('a-sid=a-id-2');
		expect(loginA.headers['set-cookie']).toContain('Expires=Tue, 21 Jul 2026 02:00:00 GMT');
		expect(loginB.headers['set-cookie']).toContain('b-sid=b-id-2');
		expect(loginB.headers['set-cookie']).toContain('Expires=Wed, 22 Jul 2026 01:00:00 GMT');
	});

	it('preserves auth failures and never records credential, token, email, subject, or session PII', async () => {
		const harness = await authHarness('p');
		const app = await buildApp({ context: harness.context });
		apps.push(app);

		harness.googleTokens.verify.mockRejectedValueOnce(new Error('bad p-secret-token'));
		const badToken = await app.inject({
			method: 'POST', url: '/api/auth/google', headers: { origin }, payload: { credential: 'p-secret-token' },
		});
		expect(badToken.statusCode).toBe(401);
		expect(badToken.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });

		harness.googleTokens.verify.mockResolvedValueOnce({
			sub: 'p-private-subject', email: 'private-email@wrong.example', name: 'Private User', hd: 'wrong.example',
		});
		const wrongDomain = await app.inject({
			method: 'POST', url: '/api/auth/google', headers: { origin }, payload: { credential: 'p-domain-token' },
		});
		expect(wrongDomain.statusCode).toBe(403);
		expect(wrongDomain.json()).toMatchObject({ error: { code: 'EMAIL_DOMAIN_NOT_ALLOWED' } });

		harness.repository.calls.userUpsert.mockRejectedValueOnce(new Error('repo leaked private-email@p.example.edu'));
		const repositoryFailure = await app.inject({
			method: 'POST', url: '/api/auth/google', headers: { origin }, payload: { credential: 'p-repo-token' },
		});
		expect(repositoryFailure.statusCode).toBe(500);
		expect(repositoryFailure.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });

		harness.repository.calls.sessionFind.mockRejectedValueOnce(new Error('find leaked p-find-session'));
		const sessionRepositoryFailure = await app.inject({
			method: 'GET', url: '/api/me', headers: { origin, cookie: 'p-sid=p-find-session' },
		});
		expect(sessionRepositoryFailure.statusCode).toBe(500);
		expect(sessionRepositoryFailure.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });

		const sensitiveSession = session('p', {
			id: 'p-secret-session',
			lastSeenAt: new Date('2026-07-20T23:00:00.000Z'),
		});
		harness.repository.calls.sessionFind.mockResolvedValueOnce(sensitiveSession);
		harness.repository.calls.sessionTouch.mockRejectedValueOnce(new Error('touch leaked p-secret-session'));
		const touchFailure = await app.inject({
			method: 'GET', url: '/api/me', headers: { origin, cookie: 'p-sid=p-secret-session' },
		});
		expect(touchFailure.statusCode).toBe(200);
		expect(touchFailure.json()).toMatchObject({ data: { authenticated: true } });
		expect(touchFailure.headers['set-cookie']).toBeUndefined();

		harness.repository.calls.sessionFind.mockResolvedValueOnce(sensitiveSession);
		harness.repository.calls.sessionDelete.mockRejectedValueOnce(new Error('logout leaked p-secret-session'));
		const logoutFailure = await app.inject({
			method: 'POST', url: '/api/auth/logout', headers: { origin, cookie: 'p-sid=p-secret-session' },
		});
		expect(logoutFailure.statusCode).toBe(200);
		expect(logoutFailure.headers['set-cookie']).toContain('p-sid=;');

		const logs = JSON.stringify(Object.values(harness.logs.calls).flatMap((call) => call.mock.calls));
		for (const forbiddenValue of [
			'p-secret-token',
			'p-domain-token',
			'p-repo-token',
			'private-email@wrong.example',
			'private-email@p.example.edu',
			'p-private-subject',
			'p-find-session',
			'p-secret-session',
		]) {
			expect(logs).not.toContain(forbiddenValue);
		}
	});

	it.each([
		['idle', session('idle', { lastSeenAt: new Date('2026-07-20T21:59:59.999Z') })],
		['absolute', session('absolute', { expiresAt: new Date('2026-07-20T23:59:59.999Z') })],
	])('expires a session at the %s policy boundary through the route plugin', async (_kind, record) => {
		const harness = await authHarness('e');
		harness.repository.calls.sessionFind.mockResolvedValueOnce(record);
		const app = await buildApp({ context: harness.context });
		apps.push(app);
		const response = await app.inject({
			method: 'GET', url: '/api/me', headers: { origin, cookie: `e-sid=${record.id}` },
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ data: { authenticated: false } });
		expect(harness.repository.calls.sessionDelete).toHaveBeenCalledWith(record.id);
		expect(response.headers['set-cookie']).toContain('e-sid=;');
	});

	it('imports and registers auth routes without env, DB, OAuth, ID, or timer work', async () => {
		const sourceRoot = new URL('../', import.meta.url);
		const guardedFiles = [
			'modules/auth/controller.ts',
			'modules/auth/index.ts',
			'modules/auth/repository.ts',
			'modules/dev-auth/controller.ts',
			'plugins/auth.ts',
		];
		for (const file of guardedFiles) {
			const source = await readFile(new URL(file, sourceRoot), 'utf8');
			expect(source).not.toMatch(/from ['"][^'"]*(?:auth\/runtime|config\/env|lib\/prisma)['"]/);
			expect(source).not.toMatch(/\b(?:new Date|randomUUID|generateSessionId)\s*\(/);
		}
		await expect(readFile(new URL('modules/auth/runtime.ts', sourceRoot), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

		const harness = await authHarness('z', { DEV_AUTH_ENABLED: true });
		expect(harness.googleTokens.verify).not.toHaveBeenCalled();
		expect(harness.repository.calls.userUpsert).not.toHaveBeenCalled();
		expect(harness.repository.calls.sessionFind).not.toHaveBeenCalled();
		expect(harness.ids.next).not.toHaveBeenCalled();
		expect(harness.clock.now).not.toHaveBeenCalled();
		expect(harness.scheduler.every).not.toHaveBeenCalled();

		const app = await buildApp({ context: harness.context });
		apps.push(app);
		expect(harness.googleTokens.verify).not.toHaveBeenCalled();
		expect(harness.repository.calls.userUpsert).not.toHaveBeenCalled();
		expect(harness.repository.calls.sessionFind).not.toHaveBeenCalled();
		expect(harness.ids.next).not.toHaveBeenCalled();
		expect(harness.clock.now).not.toHaveBeenCalled();
		expect(harness.scheduler.every).not.toHaveBeenCalled();
	});
});
