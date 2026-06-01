import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultTestEnv } from './helpers/app-mocks.js';

const mocks = vi.hoisted(() => ({
	findExhibitionById: vi.fn(),
	findProjectByExhibitionAndSlug: vi.fn(),
	createProjectWithAssets: vi.fn(),
}));

vi.mock('../config/env.js', () => ({
	env: () => ({ ...defaultTestEnv }),
	loadEnv: () => ({ ...defaultTestEnv }),
}));

vi.mock('../modules/admin/project/repository.js', () => ({
	findExhibitionById: mocks.findExhibitionById,
	findProjectByExhibitionAndSlug: mocks.findProjectByExhibitionAndSlug,
	createProjectWithAssets: mocks.createProjectWithAssets,
}));

vi.mock('../modules/assets/upload/index.js', () => ({
	UploadPipeline: vi.fn(function UploadPipeline() {
		return {
			trackTempFile: vi.fn(),
			processFile: vi.fn(),
			rollbackCommitted: vi.fn().mockResolvedValue(undefined),
			cleanupTemp: vi.fn().mockResolvedValue(undefined),
		};
	}),
}));

vi.mock('../plugins/auth.js', () => {
	const users = {
		USER: { id: 101, email: 'student@g.pcu.ac.kr', name: 'Student', role: 'USER', studentId: '20240001' },
		OPERATOR: { id: 202, email: 'operator@g.pcu.ac.kr', name: 'Operator', role: 'OPERATOR', studentId: null },
		ADMIN: { id: 303, email: 'admin@g.pcu.ac.kr', name: 'Admin', role: 'ADMIN', studentId: null },
	} as const;

	function httpError(statusCode: number, message: string, code: string) {
		const err = new Error(message) as Error & { statusCode: number; code: string };
		err.statusCode = statusCode;
		err.code = code;
		return err;
	}

	function attachUser(request: any) {
		const role = request.headers['x-test-role'] as keyof typeof users | undefined;
		if (!role || !users[role]) throw httpError(401, 'Unauthorized', 'UNAUTHORIZED');
		request.currentUser = users[role];
		return users[role];
	}

	return {
		requireLogin: async (request: any) => {
			attachUser(request);
		},
		requireRole: (...roles: string[]) => async (request: any) => {
			const user = attachUser(request);
			if (!roles.includes(user.role)) throw httpError(403, 'Forbidden', 'FORBIDDEN');
		},
	};
});

import { projectController } from '../modules/admin/project/index.js';
import { meRoutes } from '../modules/me/me.routes.js';

function validPayload(overrides: Record<string, unknown> = {}) {
	return JSON.stringify({
		exhibitionId: 7,
		title: 'My Game',
		summary: 'Short summary',
		description: 'Project description',
		members: [{ name: 'Student', studentId: '20240001' }],
		...overrides,
	});
}

async function buildTestApp() {
	const app = Fastify({ logger: false });

	app.decorateRequest('parts', (function parts(this: any) {
		const payload = this.headers['x-test-payload'] as string | undefined;
		return (async function* multipartParts() {
			yield {
				type: 'field',
				fieldname: 'payload',
				value: payload ?? validPayload(),
			};
		})();
	}) as any);

	app.setErrorHandler((error: any, _request, reply) => {
		reply.status(error.statusCode ?? 500).send({
			ok: false,
			error: {
				code: error.code ?? 'ERROR',
				message: error.message,
			},
		});
	});

	await app.register(meRoutes, { prefix: '/api/me' });
	await app.register(projectController, { prefix: '/api/admin' });
	await app.ready();
	return app;
}

describe('project submit routes', () => {
	let app: FastifyInstance;

	beforeEach(async () => {
		vi.clearAllMocks();
		mocks.findExhibitionById.mockResolvedValue({
			id: 7,
			year: 2026,
			title: '2026 Exhibition',
			isUploadEnabled: true,
		});
		mocks.findProjectByExhibitionAndSlug.mockResolvedValue(null);
		mocks.createProjectWithAssets.mockImplementation(async (data) => ({
			id: 900,
			slug: data.slug,
		}));
		app = await buildTestApp();
	});

	afterEach(async () => {
		await app.close();
	});

	it('allows USER submit via /api/me/projects/submit', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/me/projects/submit',
			headers: { 'x-test-role': 'USER' },
		});

		expect(res.statusCode).toBe(201);
		expect(mocks.createProjectWithAssets).toHaveBeenCalledWith(
			expect.objectContaining({ creatorId: 101 }),
		);
	});

	it('blocks USER submit via /api/admin/projects/submit', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/admin/projects/submit',
			headers: { 'x-test-role': 'USER' },
		});

		expect(res.statusCode).toBe(403);
		expect(mocks.createProjectWithAssets).not.toHaveBeenCalled();
	});

	it.each(['OPERATOR', 'ADMIN'] as const)(
		'allows %s submit via /api/admin/projects/submit',
		async (role) => {
			const res = await app.inject({
				method: 'POST',
				url: '/api/admin/projects/submit',
				headers: { 'x-test-role': role },
			});

			expect(res.statusCode).toBe(201);
		},
	);

	it.each([
		['status', validPayload({ status: 'ARCHIVED' })],
		['sortOrder', validPayload({ sortOrder: 99 })],
		['creatorId', validPayload({ creatorId: 999 })],
		['members.0.userId', validPayload({ members: [{ name: 'Student', studentId: '20240001', userId: 999 }] })],
	] as const)('rejects USER endpoint admin-only payload field %s', async (_field, payload) => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/me/projects/submit',
			headers: {
				'x-test-role': 'USER',
				'x-test-payload': payload,
			},
		});

		const body = JSON.parse(res.body);
		expect(res.statusCode).toBe(400);
		expect(body.error.code).toBe('USER_SUBMIT_FORBIDDEN_FIELD');
		expect(mocks.createProjectWithAssets).not.toHaveBeenCalled();
	});

	it('forces USER endpoint creator and does not accept member userId binding from payload', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/api/me/projects/submit',
			headers: { 'x-test-role': 'USER' },
		});

		expect(res.statusCode).toBe(201);
		expect(mocks.createProjectWithAssets).toHaveBeenCalledWith(
			expect.objectContaining({
				creatorId: 101,
				members: [{ name: 'Student', studentId: '20240001' }],
			}),
		);
	});
});
