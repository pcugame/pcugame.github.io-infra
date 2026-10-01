import { createWebglDisplayRepository } from '../modules/me/project/webgl-display.repository.js';
import { createWebglDisplayService } from '../modules/me/project/webgl-display.service.js';
import { createWebglDisplayController } from '../modules/me/project/webgl-display.controller.js';
import { createPublicController } from '../modules/public/controller.js';
import { createPublicService } from '../modules/public/service.js';
import { createPublicRepository } from '../modules/public/repository.js';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminProjectDetailSchema, AdminProjectListResponseSchema, PublicProjectDetailResponseSchema, WebglDisplaySettingsSchema } from '@pcu/contracts';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { Actor } from '../application/http-input.js';
import { createIsolatedMigratedDatabase } from './helpers/isolated-migrated-database.js';
import { registerAuth } from '../plugins/auth.js';
import { AppError } from '../shared/errors.js';
import { registerRouteSchemas } from '../shared/http-route-schemas.js';
import { createProjectController } from '../modules/admin/project/controller.js';
import { createProjectCrudRepository } from '../modules/admin/project/crud.repository.js';
import { createProjectService } from '../modules/admin/project/service.js';
import { createProjectSerializer } from '../modules/admin/project/serializer.js';
import { assertStatusTransition } from '../modules/admin/project/project-status.service.js';
import { createProjectAccessService } from '../modules/admin/project-access.service.js';
import { createProjectAccessRepository } from '../modules/admin/project-access.repository.js';

describe.runIf(process.env['RUN_POSTGRES_INTEGRATION'] === 'true')('WebGL display authenticated HTTP boundary', () => {
	let db: PrismaClient;
	let database: Awaited<ReturnType<typeof createIsolatedMigratedDatabase>>;
	let app: FastifyInstance;
	let exhibitionId: number;
	let owner: Actor, member: Actor, stranger: Actor, operator: Actor, admin: Actor;
	const users: number[] = [];
	const cookies = new Map<number, string>();
	beforeAll(async () => {
		database = await createIsolatedMigratedDatabase(process.env['DATABASE_URL']!);
		db = database.createClient();
		async function user(role: Actor['role']): Promise<Actor> {
			const row = await db.user.create({ data: { googleSub: randomUUID(), email: `${randomUUID()}@test.invalid`, role } });
			users.push(row.id);
			const session = await db.authSession.create({ data: { userId: row.id, expiresAt: new Date(Date.now() + 3600000) } });
			cookies.set(row.id, `sid=${session.id}`);
			return { id: row.id, role };
		}
		owner = await user('USER'); member = await user('USER'); stranger = await user('USER'); operator = await user('OPERATOR'); admin = await user('ADMIN');
		exhibitionId = (await db.exhibition.create({ data: { year: 2098, title: randomUUID() } })).id;
		app = Fastify(); app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
		await app.register(cookie);
		await registerAuth(app, {
			config: { SESSION_COOKIE_NAME: 'sid', SESSION_IDLE_MS: 3600000, SESSION_TOUCH_MIN_INTERVAL_MS: 3600000, COOKIE_SECURE: false, COOKIE_SAME_SITE: 'lax', CORS_ALLOWED_ORIGINS: ['http://localhost:5173'] },
			clock: { now: () => new Date() }, logger: app.log,
			sessions: {
				find: (id) => db.authSession.findUnique({ where: { id }, include: { user: true } }),
				delete: async (id) => { await db.authSession.delete({ where: { id } }); },
				touch: async (id, at) => { await db.authSession.update({ where: { id }, data: { lastSeenAt: at } }); },
			},
		});
		app.setErrorHandler((error, _request, reply) => {
			reply.status(error instanceof AppError ? error.statusCode : (error as { statusCode?: number }).statusCode ?? 500).send({ ok: false, error: { code: error instanceof AppError ? error.code : 'ERROR', message: error instanceof Error ? error.message : 'Error' } });
		});
		const repository = createProjectCrudRepository(db);
		const service = createProjectService({
			repository, serializeProjectDetail: createProjectSerializer('http://localhost:3000').serializeProjectDetail,
			deletionBuckets: { publicBucket: 'pcu-public', protectedBucket: 'pcu-protected' },
			abortMultipart: async () => {}, wakeDeletionWorker() {}, wakeMaintenance() {}, logger: app.log,
		});
		registerRouteSchemas(app);
		await app.register(createWebglDisplayController(createWebglDisplayService(createWebglDisplayRepository(db))), { prefix: '/api/me' });
		await app.register(createPublicController({ service: createPublicService({ repository: createPublicRepository(db), apiPublicUrl: 'http://localhost:3000' }) }), { prefix: '/api/public' });
		await app.register(createProjectController({ service, access: createProjectAccessService(createProjectAccessRepository(db)), status: { assertTransition: assertStatusTransition, bulkUpdate: async (ids, status) => ({ updated: (await repository.bulkUpdateStatus(ids, status)).count }) } }), { prefix: '/api/admin' });
	});
	afterAll(async () => {
		await app?.close();
		await database?.close();
	});
	async function project() {
		return db.project.create({ data: { exhibitionId, creatorId: owner.id, title: 'Before', slug: randomUUID(), status: 'PUBLISHED', members: { create: { name: 'Member', userId: member.id } } } });
	}
	function request(actor: Actor, method: 'GET' | 'PUT', path: string, payload?: Record<string, unknown>) {
		return app.inject({ method, url: `/api/me/projects${path}`, headers: { cookie: cookies.get(actor.id)!, origin: 'http://localhost:5173' }, ...(payload ? { payload } : {}) });
	}

	it('serializes both empty and populated authenticated admin project lists', async () => {
		const empty = await app.inject({ url: '/api/admin/projects', headers: { cookie: cookies.get(stranger.id)!, origin: 'http://localhost:5173' } });
		expect(empty.statusCode).toBe(200);
		expect(AdminProjectListResponseSchema.parse(empty.json().data).items).toEqual([]);
		const p = await project();
		const list = await app.inject({ url: '/api/admin/projects', headers: { cookie: cookies.get(owner.id)!, origin: 'http://localhost:5173' } });
		expect(list.statusCode).toBe(200);
		expect(AdminProjectListResponseSchema.parse(list.json().data).items.some((item) => item.id === p.id)).toBe(true);
	});
	it('reads unset values and persists owner/admin/operator saves, public and admin serialization, then clears', async () => {
		const p = await project();
		const path = `/${p.id}/webgl-display`;
		expect(WebglDisplaySettingsSchema.parse((await request(owner, 'GET', path)).json().data)).toEqual({ webglDisplayWidth: null, webglDisplayHeight: null });
		for (const actor of [owner, admin, operator]) {
			const settings = { webglDisplayWidth: 1280, webglDisplayHeight: 720 };
			const saved = await request(actor, 'PUT', path, settings);
			expect(saved.statusCode).toBe(200);
			expect(WebglDisplaySettingsSchema.parse(saved.json().data)).toEqual(settings);
			expect(WebglDisplaySettingsSchema.parse((await request(actor, 'GET', path)).json().data)).toEqual(settings);
			const publicDetail = await app.inject({ url: `/api/public/projects/${p.id}` });
			expect(publicDetail.statusCode).toBe(200);
			expect(PublicProjectDetailResponseSchema.parse(publicDetail.json().data)).toMatchObject(settings);
			for (const reader of [owner, member, admin]) {
				const detail = await app.inject({ url: `/api/admin/projects/${p.id}`, headers: { cookie: cookies.get(reader.id)!, origin: 'http://localhost:5173' } });
				expect(detail.statusCode).toBe(200);
				expect(AdminProjectDetailSchema.parse(detail.json().data)).toMatchObject({ ...settings, canEditWebglDisplay: reader.id !== member.id });
			}
			const cleared = await request(actor, 'PUT', path, { webglDisplayWidth: null, webglDisplayHeight: null });
			expect(cleared.statusCode).toBe(200);
			expect(cleared.json().data).toEqual({ webglDisplayWidth: null, webglDisplayHeight: null });
		}
	});
	it('denies linked members, unrelated users and anonymous readers/writers', async () => {
		const p = await project(); const path = `/${p.id}/webgl-display`;
		for (const actor of [member, stranger]) for (const method of ['GET', 'PUT'] as const) {
			expect((await request(actor, method, path, method === 'PUT' ? { webglDisplayWidth: 800, webglDisplayHeight: 600 } : undefined)).statusCode).toBe(403);
		}
		for (const method of ['GET', 'PUT'] as const) {
			expect((await app.inject({ method, url: `/api/me/projects${path}`, ...(method === 'PUT' ? { payload: { webglDisplayWidth: 800, webglDisplayHeight: 600 } } : {}) })).statusCode).toBe(401);
		}
	});
	it('rejects missing, mixed, noninteger and out-of-bounds dimensions without changing persistence', async () => {
		const p = await project(); const path = `/${p.id}/webgl-display`;
		const invalid = [{}, { webglDisplayWidth: 800 }, { webglDisplayHeight: 600 }, { webglDisplayWidth: 800, webglDisplayHeight: null }, { webglDisplayWidth: null, webglDisplayHeight: 600 },
			...[0, -1, 1.5, 8193, '1280'].flatMap((value) => [{ webglDisplayWidth: value, webglDisplayHeight: 720 }, { webglDisplayWidth: 1280, webglDisplayHeight: value }])];
		for (const payload of invalid) expect((await request(owner, 'PUT', path, payload)).statusCode).toBe(400);
		expect((await request(owner, 'GET', path)).json().data).toEqual({ webglDisplayWidth: null, webglDisplayHeight: null });
		for (const n of [1, 8192]) expect((await request(owner, 'PUT', path, { webglDisplayWidth: n, webglDisplayHeight: n })).statusCode).toBe(200);
	});
	it('preserves closed-year write restrictions while staff override and owner reads remain available', async () => {
		const p = await project(); const path = `/${p.id}/webgl-display`;
		await db.exhibition.update({ where: { id: exhibitionId }, data: { isModificationEnabled: false } });
		try {
			expect((await request(owner, 'GET', path)).statusCode).toBe(200);
			expect((await request(owner, 'PUT', path, { webglDisplayWidth: 800, webglDisplayHeight: 600 })).statusCode).toBe(403);
			for (const actor of [admin, operator]) expect((await request(actor, 'PUT', path, { webglDisplayWidth: 800, webglDisplayHeight: 600 })).statusCode).toBe(200);
		} finally { await db.exhibition.update({ where: { id: exhibitionId }, data: { isModificationEnabled: true } }); }
	});
	it('database constraint rejects incomplete and invalid pairs', async () => {
		const p = await project();
		await expect(db.project.update({ where: { id: p.id }, data: { webglDisplayWidth: 800 } })).rejects.toThrow();
		await expect(db.project.update({ where: { id: p.id }, data: { webglDisplayWidth: 8193, webglDisplayHeight: 600 } })).rejects.toThrow();
	});
});
