import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSubmitProjectService } from '../modules/admin/project/project-submit.service.js';
import { createAdminProjectSubmitController } from '../modules/admin/project/multipart.controller.js';
import { createMeProjectController } from '../modules/me/project/controller.js';
import { createMeRoutes } from '../modules/me/me.routes.js';

const repository = {
	findExhibitionById: vi.fn(),
	findProjectByExhibitionAndSlug: vi.fn(),
	createProjectMetadata: vi.fn(),
};

function validPayload(overrides: Record<string, unknown> = {}) {
	return {
		exhibitionId: 7,
		title: 'My Game',
		summary: 'Short summary',
		description: 'Project description',
		members: [{ name: 'Student', studentId: '20240001' }],
		...overrides,
	};
}

function service() {
	return createSubmitProjectService({
		webPublicUrl: 'https://web.example.test',
		repository,
		requestHasher: { hash: vi.fn(async () => 'metadata-hash') },
	});
}

async function buildTestApp(): Promise<FastifyInstance> {
	const app = Fastify({ logger: false });
	app.addHook('preHandler', async (request) => {
		const role = request.headers['x-test-role'] as 'USER' | 'OPERATOR' | 'ADMIN' | undefined;
		if (!role) return;
		const ids = { USER: 101, OPERATOR: 202, ADMIN: 303 };
		request.currentUser = {
			id: ids[role],
			googleSub: role,
			email: `${role.toLowerCase()}@g.pcu.ac.kr`,
			name: role,
			role,
		};
	});
	app.setErrorHandler((error, _request, reply) => {
		const failure = error as { statusCode?: number; code?: string };
		reply.status(failure.statusCode ?? 500).send({
			ok: false,
			error: {
				code: failure.code ?? 'ERROR',
				message: error instanceof Error ? error.message : String(error),
			},
		});
	});
	const submit = service();
	await app.register(createMeRoutes({
		projectController: createMeProjectController({
			service: submit,
			route: {
				bodyLimit: 2048,
				rateLimit: { max: 10, timeWindow: 1000 },
			},
		}),
	}), { prefix: '/api/me' });
	await app.register(createAdminProjectSubmitController({
		service: submit,
		route: {
			bodyLimit: 2048,
			rateLimit: { max: 10, timeWindow: 1000 },
		},
	}), { prefix: '/api/admin' });
	await app.ready();
	return app;
}

describe('project submit route factories', () => {
	let app: FastifyInstance;

	beforeEach(async () => {
		vi.clearAllMocks();
		repository.findExhibitionById.mockResolvedValue({
			id: 7,
			year: 2026,
			title: '2026 Exhibition',
			isUploadEnabled: true,
		});
		repository.findProjectByExhibitionAndSlug.mockResolvedValue(null);
		repository.createProjectMetadata.mockImplementation(async (data) => ({
			id: 900,
			slug: data.slug,
		}));
		app = await buildTestApp();
	});

	afterEach(async () => app.close());

	it('allows USER submit via the me prefix and fixes the actor', async () => {
		const response = await app.inject({
			method: 'POST',
			url: '/api/me/projects/submit',
			headers: { 'x-test-role': 'USER', 'idempotency-key': 'me-submit' },
			payload: validPayload(),
		});
		expect(response.statusCode).toBe(201);
		expect(repository.createProjectMetadata).toHaveBeenCalledWith(
			expect.objectContaining({ creatorId: 101, isIncomplete: true }),
		);
	});

	it('requires a bounded Idempotency-Key on submit routes', async () => {
		const missing = await app.inject({
			method: 'POST',
			url: '/api/me/projects/submit',
			headers: { 'x-test-role': 'USER' },
			payload: validPayload(),
		});
		expect(missing.statusCode).toBe(400);
		const tooLong = await app.inject({
			method: 'POST',
			url: '/api/admin/projects/submit',
			headers: {
				'x-test-role': 'ADMIN',
				'idempotency-key': 'x'.repeat(201),
			},
			payload: validPayload(),
		});
		expect(tooLong.statusCode).toBe(400);
	});

	it('blocks USER on the admin submit factory', async () => {
		const response = await app.inject({
			method: 'POST',
			url: '/api/admin/projects/submit',
			headers: { 'x-test-role': 'USER', 'idempotency-key': 'denied-submit' },
			payload: validPayload(),
		});
		expect(response.statusCode).toBe(403);
		expect(repository.createProjectMetadata).not.toHaveBeenCalled();
	});

	it.each(['OPERATOR', 'ADMIN'] as const)('allows %s on admin submit', async (role) => {
		const response = await app.inject({
			method: 'POST',
			url: '/api/admin/projects/submit',
			headers: { 'x-test-role': role, 'idempotency-key': `${role}-submit` },
			payload: validPayload(),
		});
		expect(response.statusCode).toBe(201);
	});

	it.each([
		validPayload({ status: 'ARCHIVED' }),
		validPayload({ sortOrder: 99 }),
		validPayload({ creatorId: 999 }),
		validPayload({
			members: [{
				name: 'Student',
				studentId: '20240001',
				userId: 999,
			}],
		}),
	])('rejects admin-only payload fields on the me route', async (payload) => {
		const response = await app.inject({
			method: 'POST',
			url: '/api/me/projects/submit',
			headers: {
				'x-test-role': 'USER',
				'idempotency-key': 'forbidden-fields',
			},
			payload,
		});
		expect(response.statusCode).toBe(400);
		expect(response.json().error.code).toBe('USER_SUBMIT_FORBIDDEN_FIELD');
		expect(repository.createProjectMetadata).not.toHaveBeenCalled();
	});

	it('rejects legacy file fields at the JSON contract boundary', async () => {
		const response = await app.inject({
			method: 'POST',
			url: '/api/admin/projects/submit',
			headers: { 'x-test-role': 'ADMIN', 'idempotency-key': 'legacy-files' },
			payload: { ...validPayload(), gameFile: 'game.zip' },
		});
		expect(response.statusCode).toBe(400);
		expect(response.json().error.code).toBe('VALIDATION_ERROR');
		expect(repository.createProjectMetadata).not.toHaveBeenCalled();
	});
});
