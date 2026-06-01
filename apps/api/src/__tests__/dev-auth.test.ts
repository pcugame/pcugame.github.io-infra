import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

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
	upsertUserByGoogleSub: vi.fn(),
	upsertDevUser: mocks.upsertDevUser,
	createSession: mocks.createSession,
	deleteSession: mocks.deleteSession,
	touchSession: mocks.touchSession,
}));

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
		const { buildApp } = await import('../app.js');
		app = await buildApp();
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
		const { buildApp } = await import('../app.js');
		app = await buildApp();
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
		const { buildApp } = await import('../app.js');
		app = await buildApp();
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
