import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultTestEnv } from './helpers/app-mocks.js';

const mocks = vi.hoisted(() => ({
	listProjects: vi.fn(),
	getProjectDetail: vi.fn(),
	updateProject: vi.fn(),
	deleteProject: vi.fn(),
	deleteWebgl: vi.fn(),
	setVideoOrder: vi.fn(),
	setPoster: vi.fn(),
	bulkDeleteProjects: vi.fn(),
	loadProjectWithAccess: vi.fn(),
	bulkUpdate: vi.fn(),
}));

vi.mock('../config/env.js', () => ({
	loadEnv: () => ({ ...defaultTestEnv }),
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

import { createProjectController } from '../modules/admin/project/index.js';
import type { createProjectService } from '../modules/admin/project/service.js';

const projectController = createProjectController({
	service: {
		listProjects: mocks.listProjects,
		getProjectDetail: mocks.getProjectDetail,
		updateProject: mocks.updateProject,
		deleteProject: mocks.deleteProject,
		deleteWebgl: mocks.deleteWebgl,
		setPoster: mocks.setPoster,
		setVideoOrder: mocks.setVideoOrder,
		bulkDeleteProjects: mocks.bulkDeleteProjects,
	} as ReturnType<typeof createProjectService>,
	access: { loadProjectWithAccess: mocks.loadProjectWithAccess },
	status: {
		assertTransition: vi.fn(),
		bulkUpdate: mocks.bulkUpdate,
	},
});

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
		'/api/admin/projects?sort=updatedAt',
		'/api/admin/projects?order=sideways',
	])('rejects non-whitelisted query value %s', async (url) => {
		const res = await listProjects(url);

		expect(res.statusCode).toBe(400);
		expect(mocks.listProjects).not.toHaveBeenCalled();
	});

	it('accepts DRAFT as an administrative publication-workflow status', async () => {
		const res = await listProjects('/api/admin/projects?status=DRAFT');

		expect(res.statusCode).toBe(200);
		expect(mocks.listProjects).toHaveBeenCalledWith(303, 'ADMIN', expect.objectContaining({ status: 'DRAFT' }));
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

describe('project deletion route authorization', () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		mocks.loadProjectWithAccess.mockResolvedValue({ status: 'PUBLISHED' });
		mocks.deleteProject.mockResolvedValue(undefined);
		mocks.bulkDeleteProjects.mockResolvedValue({
			deleted: 2,
			assetsRemoved: 3,
			webglBuildsRemoved: 1,
		});
		app = await buildTestApp();
	});

	afterEach(async () => {
		await app.close();
	});

	it.each(['USER', 'OPERATOR', 'ADMIN'] as const)(
		'allows an authenticated %s through the single-delete resource access policy',
		async (role) => {
			const response = await app.inject({
				method: 'DELETE',
				url: '/api/admin/projects/17',
				headers: { 'x-test-role': role },
			});

			expect(response.statusCode).toBe(204);
			expect(mocks.loadProjectWithAccess).toHaveBeenCalledWith(
				expect.objectContaining({ role }),
				17,
			);
		expect(mocks.deleteProject).toHaveBeenCalledWith(17, expect.objectContaining({ role }));
		},
	);

	it('fails a single delete closed when project ownership/membership access is denied', async () => {
		mocks.loadProjectWithAccess.mockRejectedValueOnce(Object.assign(
			new Error('Not project owner'),
			{ statusCode: 403, code: 'FORBIDDEN' },
		));

		const response = await app.inject({
			method: 'DELETE',
			url: '/api/admin/projects/17',
			headers: { 'x-test-role': 'USER' },
		});

		expect(response.statusCode).toBe(403);
		expect(mocks.deleteProject).not.toHaveBeenCalled();
	});

	it('requires authentication before the single-delete access lookup', async () => {
		const response = await app.inject({
			method: 'DELETE',
			url: '/api/admin/projects/17',
		});

		expect(response.statusCode).toBe(401);
		expect(mocks.loadProjectWithAccess).not.toHaveBeenCalled();
		expect(mocks.deleteProject).not.toHaveBeenCalled();
	});

	it.each([
		[undefined, 401],
		['USER', 403],
		['OPERATOR', 403],
	] as const)('rejects %s for bulk delete with %i', async (role, statusCode) => {
		const response = await app.inject({
			method: 'POST',
			url: '/api/admin/projects/bulk/delete',
			...(role ? { headers: { 'x-test-role': role } } : {}),
			payload: { ids: [17, 18] },
		});

		expect(response.statusCode).toBe(statusCode);
		expect(mocks.bulkDeleteProjects).not.toHaveBeenCalled();
	});

	it('allows only ADMIN to execute bulk delete without per-project access lookup', async () => {
		const response = await app.inject({
			method: 'POST',
			url: '/api/admin/projects/bulk/delete',
			headers: { 'x-test-role': 'ADMIN' },
			payload: { ids: [17, 18] },
		});

		expect(response.statusCode).toBe(200);
		expect(mocks.bulkDeleteProjects).toHaveBeenCalledWith([17, 18]);
		expect(mocks.loadProjectWithAccess).not.toHaveBeenCalled();
	});
	it('checks access and forwards the complete expected video order', async () => {
		mocks.setVideoOrder.mockResolvedValue({ order: [12, 11] });
		const res = await app.inject({ method: 'PUT', url: '/api/admin/projects/7/videos/order',
			headers: { 'x-test-role': 'ADMIN' }, payload: { expectedOrder: [11, 12], order: [12, 11] } });
		expect(res.statusCode).toBe(200);
		expect(mocks.loadProjectWithAccess).toHaveBeenCalledWith(expect.objectContaining({ id: 303 }), 7);
	expect(mocks.setVideoOrder).toHaveBeenCalledWith(7, [11, 12], [12, 11], expect.objectContaining({ role: 'ADMIN' }));
	});
	it('lets the repository return 409 for a legacy project with more than five videos', async () => {
		mocks.setVideoOrder.mockRejectedValue(Object.assign(new Error('Project exceeds the five video limit'), { statusCode: 409 }));
		const order = [1, 2, 3, 4, 5, 6];
		const res = await app.inject({ method: 'PUT', url: '/api/admin/projects/7/videos/order',
			headers: { 'x-test-role': 'ADMIN' }, payload: { expectedOrder: order, order } });
		expect(res.statusCode).toBe(409);
	});
	it('denies video ordering when the actor has no project access', async () => {
		mocks.loadProjectWithAccess.mockRejectedValueOnce(Object.assign(new Error('Not your project'), { statusCode: 403 }));
		const res = await app.inject({ method: 'PUT', url: '/api/admin/projects/7/videos/order',
			headers: { 'x-test-role': 'USER' }, payload: { expectedOrder: [11], order: [11] } });
		expect(res.statusCode).toBe(403);
		expect(mocks.setVideoOrder).not.toHaveBeenCalled();
	});

});
