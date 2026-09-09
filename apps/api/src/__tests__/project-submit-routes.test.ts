import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSubmitProjectService } from '../modules/admin/project/project-submit.service.js';
import { createAdminProjectSubmitController } from '../modules/admin/project/multipart.controller.js';
import { createMeProjectController } from '../modules/me/project/controller.js';
import { createMeRoutes } from '../modules/me/me.routes.js';

const repository = {
	findExhibitionById: vi.fn(),
	findProjectByExhibitionAndSlug: vi.fn(),
	createProjectWithAssets: vi.fn(),
};
const pipeline = {
	trackTempFile: vi.fn(),
	processFile: vi.fn(),
	rollbackCommitted: vi.fn(async () => {}),
	cleanupTemp: vi.fn(async () => {}),
};

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

function service() {
	return createSubmitProjectService({
		webPublicUrl: 'https://web.example.test',
		repository,
		uploadLimits: () => ({
			posterMaxBytes: 1024,
			imageMaxBytes: 1024,
			gameMaxBytes: 1024,
			videoMaxBytes: 1024,
			requestMaxBytes: 2048,
			maxFiles: 4,
		}),
		uploadSlots: { acquire: vi.fn(), release: vi.fn() },
		createPipeline: () => pipeline,
		multipartCollector: {
			collect: async (parts) => {
				let payloadJson = '';
				for await (const part of parts) {
					if (part.type === 'field' && part.fieldname === 'payload') {
						payloadJson = String(part.value);
					}
				}
				return { payloadJson, fileParts: [] };
			},
		},
	});
}

async function buildTestApp(): Promise<FastifyInstance> {
	const app = Fastify({ logger: false });
	app.decorateRequest('parts', (function parts(this: {
		headers: Record<string, string | undefined>;
	}) {
		const payload = this.headers['x-test-payload'];
		return (async function* multipartParts() {
			yield {
				type: 'field' as const,
				fieldname: 'payload',
				value: payload ?? validPayload(),
			};
		})();
	}) as never);
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
		repository.createProjectWithAssets.mockImplementation(async (data) => ({
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
		});
		expect(response.statusCode).toBe(201);
		expect(repository.createProjectWithAssets).toHaveBeenCalledWith(
			expect.objectContaining({ creatorId: 101 }),
		);
	});

	it('requires a bounded Idempotency-Key on submit routes', async () => {
		const missing = await app.inject({
			method: 'POST',
			url: '/api/me/projects/submit',
			headers: { 'x-test-role': 'USER' },
		});
		expect(missing.statusCode).toBe(400);
		const tooLong = await app.inject({
			method: 'POST',
			url: '/api/admin/projects/submit',
			headers: {
				'x-test-role': 'ADMIN',
				'idempotency-key': 'x'.repeat(201),
			},
		});
		expect(tooLong.statusCode).toBe(400);
	});

	it('blocks USER on the admin submit factory', async () => {
		const response = await app.inject({
			method: 'POST',
			url: '/api/admin/projects/submit',
			headers: { 'x-test-role': 'USER', 'idempotency-key': 'denied-submit' },
		});
		expect(response.statusCode).toBe(403);
		expect(repository.createProjectWithAssets).not.toHaveBeenCalled();
	});

	it.each(['OPERATOR', 'ADMIN'] as const)('allows %s on admin submit', async (role) => {
		const response = await app.inject({
			method: 'POST',
			url: '/api/admin/projects/submit',
			headers: { 'x-test-role': role, 'idempotency-key': `${role}-submit` },
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
				'x-test-payload': payload,
				'idempotency-key': 'forbidden-fields',
			},
		});
		expect(response.statusCode).toBe(400);
		expect(response.json().error.code).toBe('USER_SUBMIT_FORBIDDEN_FIELD');
		expect(repository.createProjectWithAssets).not.toHaveBeenCalled();
	});
});
