import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultTestEnv } from './helpers/app-mocks.js';

const mocks = vi.hoisted(() => ({
	listProjects: vi.fn(),
}));

vi.mock('../config/env.js', () => ({
	env: () => ({ ...defaultTestEnv }),
	loadEnv: () => ({ ...defaultTestEnv }),
}));

vi.mock('../modules/admin/project/service.js', () => ({
	listProjects: mocks.listProjects,
	assertStatusTransition: vi.fn(),
	bulkUpdateStatus: vi.fn(),
	submitProject: vi.fn(),
	addAssetToProject: vi.fn(),
	setPoster: vi.fn(),
	deleteProject: vi.fn(),
	bulkDeleteProjects: vi.fn(),
}));

vi.mock('../modules/admin/project/repository.js', () => ({
	findExhibitionById: vi.fn(),
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

async function buildTestApp() {
	const app = Fastify({ logger: false });
	app.setErrorHandler((error: any, _request, reply) => {
		reply.status(error.statusCode ?? 500).send({
			ok: false,
			error: {
				code: error.code ?? 'ERROR',
				message: error.message,
				...(error.details !== undefined ? { details: error.details } : {}),
			},
		});
	});
	await app.register(projectController, { prefix: '/api/admin' });
	await app.ready();
	return app;
}

function listProjects(url: string, role: 'USER' | 'OPERATOR' | 'ADMIN' = 'ADMIN') {
	return app.inject({
		method: 'GET',
		url,
		headers: { 'x-test-role': role },
	});
}

let app: FastifyInstance;

describe('admin project list route query', () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		mocks.listProjects.mockResolvedValue({
			items: [],
			pagination: {
				page: 1,
				limit: 20,
				totalItems: 0,
				totalPages: 0,
				hasNextPage: false,
				hasPreviousPage: false,
			},
		});
		app = await buildTestApp();
	});

	afterEach(async () => {
		await app.close();
	});

	it('applies default page and limit', async () => {
		const res = await listProjects('/api/admin/projects');

		expect(res.statusCode).toBe(200);
		expect(mocks.listProjects).toHaveBeenCalledWith(303, 'ADMIN', {
			page: 1,
			limit: 20,
			sort: 'createdAt',
			order: 'desc',
		});
	});

	it('caps limit at 100', async () => {
		const res = await listProjects('/api/admin/projects?page=2&limit=500');

		expect(res.statusCode).toBe(200);
		expect(mocks.listProjects).toHaveBeenCalledWith(303, 'ADMIN', expect.objectContaining({
			page: 2,
			limit: 100,
		}));
	});

	it.each([
		'/api/admin/projects?page=0',
		'/api/admin/projects?page=-1',
		'/api/admin/projects?limit=0',
		'/api/admin/projects?limit=bad',
	])('rejects invalid pagination query %s', async (url) => {
		const res = await listProjects(url);

		expect(res.statusCode).toBe(400);
		expect(mocks.listProjects).not.toHaveBeenCalled();
	});

	it('accepts whitelisted filters and sorting', async () => {
		const res = await listProjects('/api/admin/projects?search=alpha&year=2026&status=PUBLISHED&sort=title&order=asc');

		expect(res.statusCode).toBe(200);
		expect(mocks.listProjects).toHaveBeenCalledWith(303, 'ADMIN', {
			page: 1,
			limit: 20,
			search: 'alpha',
			year: 2026,
			status: 'PUBLISHED',
			sort: 'title',
			order: 'asc',
		});
	});

	it.each([
		'/api/admin/projects?status=DRAFT',
		'/api/admin/projects?sort=updatedAt',
		'/api/admin/projects?order=sideways',
	])('rejects non-whitelisted query value %s', async (url) => {
		const res = await listProjects(url);

		expect(res.statusCode).toBe(400);
		expect(mocks.listProjects).not.toHaveBeenCalled();
	});

	it('passes USER role through for role-scoped pagination', async () => {
		const res = await listProjects('/api/admin/projects?page=3', 'USER');

		expect(res.statusCode).toBe(200);
		expect(mocks.listProjects).toHaveBeenCalledWith(101, 'USER', expect.objectContaining({
			page: 3,
			limit: 20,
		}));
	});
});
