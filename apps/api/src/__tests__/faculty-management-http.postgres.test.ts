import multipart from '@fastify/multipart';
import { createAdminProjectMetadataController } from '../modules/admin/project/metadata.controller.js';
import { createSubmitProjectService } from '../modules/admin/project/project-submit.service.js';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminProjectDetailSchema, AdminProjectListResponseSchema, GoogleAuthResponseSchema, MeResponseSchema } from '@pcu/contracts';
import type { PrismaClient } from '../generated/prisma/client.js';
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

import { createAuthRepository } from '../modules/auth/repository.js';
import { createAuthService } from '../modules/auth/service.js';
import { createAuthController } from '../modules/auth/controller.js';

// Real database, session middleware and response serializers; only Google verification is substituted.
describe.runIf(process.env['RUN_POSTGRES_INTEGRATION'] === 'true')('faculty login and management HTTP boundary', () => {
	let db: PrismaClient;
	let database: Awaited<ReturnType<typeof createIsolatedMigratedDatabase>>;
	let app: FastifyInstance;
	let exhibitionId: number;
	const subject = randomUUID();
	const origin = 'http://localhost:5173';
	beforeAll(async () => {
		database = await createIsolatedMigratedDatabase(process.env['DATABASE_URL']!);
		db = database.createClient();
		exhibitionId = (await db.exhibition.create({ data: { year: 2098, title: 'Faculty test', isModificationEnabled: true } })).id;
		app = Fastify(); app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
		await app.register(cookie); await app.register(multipart);
		const config = { SESSION_COOKIE_NAME: 'sid', SESSION_IDLE_MS: 3600000, SESSION_TOUCH_MIN_INTERVAL_MS: 3600000, COOKIE_SECURE: false, COOKIE_SAME_SITE: 'lax' as const, CORS_ALLOWED_ORIGINS: [origin], RATE_LIMIT_LOGIN_MAX: 100, RATE_LIMIT_LOGIN_WINDOW_MS: 60000 };
		const clock = { now: () => new Date() };
		const authRepository = createAuthRepository(db);
		await registerAuth(app, { config, clock, logger: app.log, sessions: authRepository });
		app.setErrorHandler((error, _request, reply) => {
			reply.status(error instanceof AppError ? error.statusCode : (error as { statusCode?: number }).statusCode ?? 500).send({ ok: false, error: { code: error instanceof AppError ? error.code : 'ERROR', message: error instanceof Error ? error.message : 'Error' } });
		});
		const auth = createAuthService({ repository: authRepository, googleTokens: { verify: async () => ({ sub: subject, email: 'A00000@pcu.ac.kr', hd: 'pcu.ac.kr', name: '교원' }) }, clock, ids: { next: randomUUID }, sessionAbsoluteMs: 3600000, googleClientIds: ['test'], allowedGoogleHostedDomain: 'pcu.ac.kr', logger: app.log });
		const repository = createProjectCrudRepository(db);
		const service = createProjectService({
			repository, serializeProjectDetail: createProjectSerializer('http://localhost:3000').serializeProjectDetail,
			deletionBuckets: { publicBucket: 'pcu-public', protectedBucket: 'pcu-protected' },
			abortMultipart: async () => {}, wakeDeletionWorker() {}, wakeMaintenance() {}, logger: app.log,
		});
		registerRouteSchemas(app);
		await app.register(createAuthController({ config, clock, service: auth }), { prefix: '/api' });
		await app.register(createAdminProjectMetadataController({ service: createSubmitProjectService({ repository, webPublicUrl: 'http://localhost:5173' }), route: { rateLimit: { max: 100, timeWindow: 60000 } } }), { prefix: '/api/admin' });
		await app.register(createProjectController({ service, access: createProjectAccessService(createProjectAccessRepository(db)), status: { assertTransition: assertStatusTransition, bulkUpdate: async (ids, status) => ({ updated: (await repository.bulkUpdateStatus(ids, status)).count }) } }), { prefix: '/api/admin' });
	});
	afterAll(async () => { await app?.close(); await database?.close(); });
	it('keeps faculty USER unprivileged, preserves explicit ADMIN, and records the creator without a participant link', async () => {
		async function login() {
			const response = await app.inject({ method: 'POST', url: '/api/auth/google', headers: { origin }, payload: { credential: 'test-verified-token' } });
			expect(response.statusCode, response.body).toBe(200);
			const data = GoogleAuthResponseSchema.parse(response.json().data);
			expect(data.user).not.toHaveProperty('studentId');
			const cookieHeader = String(response.headers['set-cookie']).split(';')[0];
			return { data, headers: { origin, cookie: cookieHeader } };
		}
		const first = await login();
		expect(first.data.user.role).toBe('USER');
		expect((await app.inject({ method: 'GET', url: '/api/admin/project-submissions/audit', headers: first.headers })).statusCode).toBe(403);
		const id = first.data.user.id;
		expect((await db.user.findUniqueOrThrow({ where: { id } })).studentId).toBeNull();
		await db.user.update({ where: { id, googleSub: subject, role: 'USER' }, data: { role: 'ADMIN' } });
		const admin = await login();
		expect(admin.data.user.role).toBe('ADMIN');
		const me = await app.inject({ method: 'GET', url: '/api/me', headers: admin.headers });
		expect(me.statusCode, me.body).toBe(200);
		const profile = MeResponseSchema.parse(me.json().data);
		expect(profile).toMatchObject({ authenticated: true, user: { id, role: 'ADMIN' } });
		expect(me.json().data.user).not.toHaveProperty('studentId');
		const empty = await app.inject({ method: 'GET', url: '/api/admin/projects', headers: admin.headers });
		expect(empty.statusCode, empty.body).toBe(200);
		expect(AdminProjectListResponseSchema.parse(empty.json().data).items).toEqual([]);
		const boundary = 'faculty-metadata';
		const payload = { exhibitionId, title: 'Faculty registered project', members: [{ name: '교원', studentId: '20260001' }], manifest: [] };
		const created = await app.inject({ method: 'POST', url: '/api/admin/projects/submit', headers: { ...admin.headers, 'idempotency-key': randomUUID(), 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: `--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\n\r\n${JSON.stringify(payload)}\r\n--${boundary}--\r\n` });
		expect(created.statusCode, created.body).toBe(201);
		const projectId = created.json().data.id as number;
		const stored = await db.project.findUniqueOrThrow({ where: { id: projectId }, include: { members: true } });
		expect(stored.creatorId).toBe(id);
		expect((await db.projectSubmission.findFirstOrThrow({ where: { projectId } })).actorId).toBe(id);
		expect(stored.members).toHaveLength(1);
		expect(stored.members[0]).toMatchObject({ name: '교원', studentId: '20260001', userId: null });
		const status = await app.inject({ method: 'GET', url: `/api/admin/projects/${projectId}/submission`, headers: admin.headers });
		expect(status.statusCode, status.body).toBe(200);
		expect(status.json().data).toMatchObject({ state: 'PENDING', items: [] });
		const populated = await app.inject({ method: 'GET', url: '/api/admin/projects', headers: admin.headers });
		expect(populated.statusCode, populated.body).toBe(200);
		expect(AdminProjectListResponseSchema.parse(populated.json().data).items).toHaveLength(1);
		const detail = await app.inject({ method: 'GET', url: `/api/admin/projects/${projectId}`, headers: admin.headers });
		expect(detail.statusCode, detail.body).toBe(200);
		expect(AdminProjectDetailSchema.parse(detail.json().data).members[0]?.userId).toBeNull();
		const edit = await app.inject({ method: 'PATCH', url: `/api/admin/projects/${projectId}`, headers: admin.headers, payload: { title: 'Reviewed by faculty' } });
		expect(edit.statusCode, edit.body).toBe(200);
		expect(AdminProjectDetailSchema.parse(edit.json().data).title).toBe('Reviewed by faculty');
		await db.user.update({ where: { id }, data: { role: 'USER' } });
		expect((await app.inject({ method: 'GET', url: '/api/admin/project-submissions/audit', headers: admin.headers })).statusCode).toBe(403);
	});
});
