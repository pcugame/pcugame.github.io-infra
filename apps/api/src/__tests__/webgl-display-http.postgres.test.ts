import { createProjectPublicationRepository } from '../modules/project-publication/repository.js';
import multipart from '@fastify/multipart';
import { createAdminProjectMetadataController } from '../modules/admin/project/metadata.controller.js';
import { createSubmitProjectService } from '../modules/admin/project/project-submit.service.js';
import { createWebglDisplayRepository } from '../modules/me/project/webgl-display.repository.js';
import { createWebglDisplayService } from '../modules/me/project/webgl-display.service.js';
import { createWebglDisplayController } from '../modules/me/project/webgl-display.controller.js';
import { createPublicController } from '../modules/public/controller.js';
import { createPublicService } from '../modules/public/service.js';
import { createPublicRepository } from '../modules/public/repository.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminProjectDetailSchema, AdminProjectListResponseSchema, PublicProjectDetailResponseSchema, WebglDisplaySettingsResponseSchema } from '@pcu/contracts';
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
		await db.storageBucket.createMany({ data: [{ bucket: 'pcu-public', visibility: 'PUBLIC' }, { bucket: 'pcu-protected', visibility: 'PROTECTED' }] });
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
		await app.register(multipart);
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
		await app.register(createAdminProjectMetadataController({ service: createSubmitProjectService({ repository, webPublicUrl: 'http://localhost:5173' }), route: { rateLimit: { max: 100, timeWindow: 60000 } } }), { prefix: '/api/admin' });
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

	it.each([
		{ platforms: ['PC', 'WEB'], hardwareRequirements: '  VR headset required  ' },
		{ platforms: [], hardwareRequirements: '' },
	])('creates, edits and serializes hardware/platform metadata through authenticated HTTP: %j', async (metadata) => {
		const boundary = 'metadata-test-boundary';
		const payload = { exhibitionId, title: `Hardware ${randomUUID()}`, members: [{ name: 'Student', studentId: '20260001' }], manifest: [], ...metadata };
		const created = await app.inject({ method: 'POST', url: '/api/admin/projects/submit', headers: { cookie: cookies.get(admin.id)!, origin: 'http://localhost:5173', 'idempotency-key': randomUUID(), 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: `--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\n\r\n${JSON.stringify(payload)}\r\n--${boundary}--\r\n` });
		expect(created.statusCode, created.body).toBe(201);
		const id = created.json().data.id as number;
		const expected = { platforms: metadata.platforms, hardwareRequirements: metadata.hardwareRequirements.trim() };
		const headers = { cookie: cookies.get(admin.id)!, origin: 'http://localhost:5173' };
		const detail = await app.inject({ url: `/api/admin/projects/${id}`, headers });
		expect(detail.statusCode, detail.body).toBe(200);
		expect(AdminProjectDetailSchema.parse(detail.json().data)).toMatchObject(expected);
		const finalized = await app.inject({ method: 'POST', url: `/api/admin/projects/${id}/submission/finalize`, headers });
		expect(finalized.statusCode, finalized.body).toBe(200);
		const publication = createProjectPublicationRepository(db);
		const token = randomUUID();
		const job = await publication.claim({ token, leaseMs: 60000 });
		expect(job?.projectId).toBe(id);
		const validated = await publication.validatePlan(job!, token);
		expect(validated.status, JSON.stringify(validated)).toBe('VALID');
		if (validated.status !== 'VALID') throw new Error('Metadata publication validation failed');
		expect(await publication.complete(validated.job, token)).toBe('COMPLETED');
		const readPublic = async () => {
			const response = await app.inject({ url: `/api/public/projects/${id}`, headers });
			expect(response.statusCode, response.body).toBe(200);
			return PublicProjectDetailResponseSchema.parse(response.json().data);
		};
		expect(await readPublic()).toMatchObject(expected);
		const preserved = await app.inject({ method: 'PATCH', url: `/api/admin/projects/${id}`, headers, payload: { summary: 'Other metadata edit' } });
		expect(preserved.statusCode, preserved.body).toBe(200);
		expect(AdminProjectDetailSchema.parse(preserved.json().data)).toMatchObject(expected);
		for (const update of [{ platforms: ['MOBILE'], hardwareRequirements: '  Controller required  ' }, { platforms: [], hardwareRequirements: '' }]) {
			const edited = await app.inject({ method: 'PATCH', url: `/api/admin/projects/${id}`, headers, payload: update });
			expect(edited.statusCode, edited.body).toBe(200);
			const normalized = { ...update, hardwareRequirements: update.hardwareRequirements.trim() };
			expect(AdminProjectDetailSchema.parse(edited.json().data)).toMatchObject(normalized);
			expect(await readPublic()).toMatchObject(normalized);
		}
	});
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
		expect(WebglDisplaySettingsResponseSchema.parse((await request(owner, 'GET', path)).json().data)).toEqual({ webglDisplayMode: 'auto', webglDisplayWidth: null, webglDisplayHeight: null, analysis: null, effective: { kind: 'legacy', width: null, height: null } });
		for (const actor of [owner, admin, operator]) {
			const settings = { webglDisplayWidth: 1280, webglDisplayHeight: 720 };
			const saved = await request(actor, 'PUT', path, settings);
			expect(saved.statusCode).toBe(200);
			expect(WebglDisplaySettingsResponseSchema.parse(saved.json().data)).toMatchObject({ ...settings, webglDisplayMode: 'manual', effective: {kind: 'fixed', width: 1280, height: 720} });
			expect(WebglDisplaySettingsResponseSchema.parse((await request(actor, 'GET', path)).json().data)).toMatchObject({ ...settings, webglDisplayMode: 'manual' });
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
			expect(cleared.json().data).toEqual({ webglDisplayMode: 'legacy', webglDisplayWidth: null, webglDisplayHeight: null, analysis: null, effective: { kind: 'legacy', width: null, height: null } });
		}
	});
	it('reports only current ready deployment analysis in settings and public responses', async () => {
		const p = await project(); const path = `/${p.id}/webgl-display`;
		await db.storageBucket.upsert({ where: { bucket: 'pcu-public' }, create: { bucket: 'pcu-public', visibility: 'PUBLIC' }, update: {} });
		await db.storageBucket.upsert({ where: { bucket: 'pcu-protected' }, create: { bucket: 'pcu-protected', visibility: 'PROTECTED' }, update: {} });
		const source = await db.asset.create({ data: { projectId: p.id, kind: 'WEBGL', representations: { create: { role: 'WEBGL_SOURCE', state: 'READY', mimeType: 'application/octet-stream', bucket: 'pcu-protected', objectKey: randomUUID() } } }, include: { representations: true } });
		const fixed = { version: 1, kind: 'fixed', width: 960, height: 600, reason: null };
		async function deployment(state: 'READY' | 'PENDING', analysis: typeof fixed) {
			const id = randomUUID(), prefix = `public/webgl/${p.id}/${id}/`;
			return db.webglDeployment.create({ data: { id, projectId: p.id, sourceRepresentationId: source.representations[0]!.id, publicBucket: 'pcu-public', publicPrefix: prefix, entryObjectKey: prefix + 'index.html', state, displayAnalysis: analysis, objectManifest: { version: 1, objects: [{ objectKey: prefix + 'index.html', sizeBytes: '1', mimeType: 'text/html' }] } } });
		}
		await deployment('PENDING', { ...fixed, width: 1920 });
		expect((await request(owner, 'GET', path)).json().data.analysis).toBeNull();
		const ready = await deployment('READY', fixed);
		await db.project.update({ where: { id: p.id }, data: { currentWebglDeploymentId: ready.id } });
		expect(WebglDisplaySettingsResponseSchema.parse((await request(owner, 'GET', path)).json().data)).toMatchObject({ analysis: fixed, effective: { kind: 'fixed', width: 960, height: 600 } });
		expect(PublicProjectDetailResponseSchema.parse((await app.inject({ url: `/api/public/projects/${p.id}` })).json().data)).toMatchObject({ webglDisplayKind: 'fixed', webglDisplayWidth: 960, webglDisplayHeight: 600 });
		await db.webglDeployment.update({ where: { id: ready.id }, data: { displayAnalysis: { version: 1, kind: 'responsive', width: null, height: null, reason: null } } });
		expect((await request(owner, 'GET', path)).json().data.effective).toEqual({ kind: 'responsive', width: null, height: null });
		expect((await app.inject({ url: `/api/public/projects/${p.id}` })).json().data).toMatchObject({ webglDisplayKind: 'responsive', webglDisplayWidth: null, webglDisplayHeight: null });
		await db.webglDeployment.update({ where: { id: ready.id }, data: { displayAnalysis: { version: 1, kind: 'unknown', width: null, height: null, reason: 'Ambiguous' } } });
		expect((await request(owner, 'GET', path)).json().data).toMatchObject({ analysis: { kind: 'unknown', reason: 'Ambiguous' }, effective: { kind: 'legacy', width: null, height: null } });
		expect((await app.inject({ url: `/api/public/projects/${p.id}` })).json().data).toMatchObject({ webglDisplayKind: 'legacy', webglDisplayWidth: null, webglDisplayHeight: null });
		await request(owner, 'PUT', path, { webglDisplayMode: 'manual', webglDisplayWidth: 1280, webglDisplayHeight: 720 });
		const replacement = await deployment('READY', { ...fixed, width: 1920 });
		await db.project.update({ where: { id: p.id }, data: { currentWebglDeploymentId: replacement.id } });
		expect((await request(owner, 'GET', path)).json().data).toMatchObject({ webglDisplayMode: 'manual', webglDisplayWidth: 1280, webglDisplayHeight: 720, analysis: { width: 1920 }, effective: { kind: 'fixed', width: 1280, height: 720 } });
		await request(owner, 'PUT', path, { webglDisplayMode: 'auto', webglDisplayWidth: 1280, webglDisplayHeight: 720 });
		expect((await request(owner, 'GET', path)).json().data.effective).toEqual({ kind: 'fixed', width: 1920, height: 600 });
		await db.project.update({ where: { id: p.id }, data: { currentWebglDeploymentId: null } });
		expect((await request(owner, 'GET', path)).json().data.analysis).toBeNull();
		expect((await app.inject({ url: `/api/public/projects/${p.id}` })).json().data).toMatchObject({ webglDisplayKind: 'legacy', webglDisplayWidth: null, webglDisplayHeight: null });
	});
	it('preserves manual dimensions across mode switches and validates manual mode', async () => {
		const p = await project(); const path = `/${p.id}/webgl-display`;
		for (const webglDisplayMode of ['manual', 'auto', 'legacy']) {
			const response = await request(owner, 'PUT', path, { webglDisplayMode, webglDisplayWidth: 800, webglDisplayHeight: 600 });
			expect(response.statusCode, response.body).toBe(200);
			expect(WebglDisplaySettingsResponseSchema.parse(response.json().data)).toMatchObject({ webglDisplayMode, webglDisplayWidth: 800, webglDisplayHeight: 600, effective: webglDisplayMode === 'manual' ? {kind: 'fixed', width: 800, height: 600} : {kind: 'legacy', width: null, height: null} });
		}
		expect((await request(owner, 'PUT', path, { webglDisplayMode: 'manual', webglDisplayWidth: null, webglDisplayHeight: null })).statusCode).toBe(400);
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
		expect((await request(owner, 'GET', path)).json().data).toMatchObject({ webglDisplayMode: 'auto', webglDisplayWidth: null, webglDisplayHeight: null });
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
	it('migration keeps existing fixed pairs manual and defaults unset and new projects to auto', async () => {
		const schema = `display_migration_${randomUUID().replaceAll('-', '')}`;
		const sql = await readFile(new URL('../../prisma/migrations/20261001000002_webgl_display_analysis/migration.sql', import.meta.url), 'utf8');
		await db.$transaction(async (tx) => {
			await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"; SET LOCAL search_path TO "${schema}"; CREATE TABLE projects (id integer PRIMARY KEY, webgl_display_width integer, webgl_display_height integer); CREATE TABLE webgl_deployments (id text PRIMARY KEY); INSERT INTO projects VALUES (1, 1280, 720), (2, NULL, NULL);`);
			await tx.$executeRawUnsafe(sql);
			await tx.$executeRawUnsafe('INSERT INTO projects (id) VALUES (3)');
			expect(await tx.$queryRawUnsafe('SELECT id, webgl_display_mode AS mode FROM projects ORDER BY id')).toEqual([{ id: 1, mode: 'manual' }, { id: 2, mode: 'auto' }, { id: 3, mode: 'auto' }]);
			await tx.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
		});
	});
	it('database constraint rejects incomplete and invalid pairs', async () => {
		const p = await project();
		await expect(db.project.update({ where: { id: p.id }, data: { webglDisplayWidth: 800 } })).rejects.toThrow();
		await expect(db.project.update({ where: { id: p.id }, data: { webglDisplayWidth: 8193, webglDisplayHeight: 600 } })).rejects.toThrow();
	});
});
