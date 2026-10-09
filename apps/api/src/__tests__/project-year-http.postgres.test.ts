import { createProjectChangeService } from '../modules/project-change/service.js';
import { createProjectChangeRepository } from '../modules/project-change/repository.js';
import { createExhibitionRepository } from '../modules/admin/year/repository.js';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminProjectDetailSchema, AdminProjectListResponseSchema } from '@pcu/contracts';
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

describe.runIf(process.env['RUN_POSTGRES_INTEGRATION'] === 'true')('year policy authenticated HTTP boundary', () => {
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
			reply.status(error instanceof AppError ? error.statusCode : 500).send({ ok: false, error: { code: error instanceof AppError ? error.code : 'ERROR', message: error instanceof Error ? error.message : 'Error' } });
		});
		const repository = createProjectCrudRepository(db);
		const service = createProjectService({
			repository, serializeProjectDetail: createProjectSerializer('http://localhost:3000', { publicAssetOrigin: 'http://assets.test', publicBucket: 'pcu-public' }).serializeProjectDetail,
			deletionBuckets: { publicBucket: 'pcu-public', protectedBucket: 'pcu-protected' },
			abortMultipart: async () => {}, wakeDeletionWorker() {}, wakeMaintenance() {}, logger: app.log,
		});
		registerRouteSchemas(app);
		await app.register(createProjectController({ service, access: createProjectAccessService(createProjectAccessRepository(db)), status: { assertTransition: assertStatusTransition, bulkUpdate: async (ids, status) => ({ updated: (await repository.bulkUpdateStatus(ids, status)).count }) } }), { prefix: '/api/admin' });
	});
	afterAll(async () => {
		await app?.close();
		await database?.close();
	});
	async function project() {
		return db.project.create({ data: { exhibitionId, creatorId: owner.id, title: 'Before', slug: randomUUID(), status: 'PUBLISHED', members: { create: { name: 'Member', userId: member.id } } } });
	}
	function request(actor: Actor, method: 'GET' | 'PATCH' | 'DELETE', path: string, payload?: Record<string, unknown>) {
		return app.inject({ method, url: `/api/admin/projects${path}`, headers: { cookie: cookies.get(actor.id)!, origin: 'http://localhost:5173' }, ...(payload ? { payload } : {}) });
	}
	it('serializes capabilities and permits owner/team direct changes only when open', async () => {
		const empty = await request(stranger, 'GET', '');
		expect(empty.statusCode).toBe(200);
		expect(AdminProjectListResponseSchema.parse(empty.json().data).items).toEqual([]);
		const p = await project();
		for (const actor of [owner, member]) {
			const list = await request(actor, 'GET', '');
			expect(AdminProjectListResponseSchema.parse(list.json().data).items.find((item) => item.id === p.id)).toMatchObject({ canEdit: true, canDelete: true, canRequestChange: false });
			const updated = await request(actor, 'PATCH', `/${p.id}`, { title: `By ${actor.id}` });
			expect(updated.statusCode).toBe(200);
			expect(AdminProjectDetailSchema.parse(updated.json().data)).toMatchObject({ canEdit: true, canDelete: true, assets: [] });
		}
		expect((await request(stranger, 'PATCH', `/${p.id}`, { title: 'Intrusion' })).statusCode).toBe(403);
		expect((await app.inject({ method: 'DELETE', url: `/api/admin/projects/${p.id}` })).statusCode).toBe(401);
		await db.exhibition.update({ where: { id: exhibitionId }, data: { isModificationEnabled: false } });
		for (const actor of [owner, member]) {
			const detail = await request(actor, 'GET', `/${p.id}`);
			expect(AdminProjectDetailSchema.parse(detail.json().data)).toMatchObject({ canEdit: false, canDelete: false, canRequestChange: true });
			const denied = await request(actor, 'PATCH', `/${p.id}`, { title: 'Closed' });
			expect(denied.statusCode).toBe(403);
			expect(denied.json()).toEqual({ ok: false, error: {
				code: 'FORBIDDEN', message: 'Project modifications are closed for this exhibition',
			} });
			expect((await request(actor, 'DELETE', `/${p.id}`)).statusCode).toBe(403);
		}
		for (const actor of [operator, admin]) {
			const updated = await request(actor, 'PATCH', `/${p.id}`, { title: 'Operator edit' });
			expect(updated.statusCode).toBe(200);
			expect(AdminProjectDetailSchema.parse(updated.json().data).canEdit).toBe(true);
			const removable = await project();
			expect((await request(actor, 'DELETE', `/${removable.id}`)).statusCode).toBe(204);
		}
		await db.exhibition.update({ where: { id: exhibitionId }, data: { isModificationEnabled: true } });
		for (const actor of [owner, member]) {
			const removable = await project();
			expect((await request(actor, 'DELETE', `/${removable.id}`)).statusCode).toBe(204);
		}
	});
	it('returns required assets through authenticated list, detail and update serialization', async () => {
		const p = await project();
		const none = { nativeBuild: { ready: false, processing: false, failed: false }, webBuild: { ready: false, processing: false, failed: false }, video: { ready: false, processing: false, failed: false }, poster: { ready: false, processing: false, failed: false }, readyCount: 0, totalCount: 4, complete: false };
		async function summary() {
			const list = await request(owner, 'GET', '');
			expect(list.statusCode).toBe(200);
			const item = list.json().data.items.find((item: { id: number }) => item.id === p.id);
			const detail = await request(owner, 'GET', `/${p.id}`);
			expect(detail.statusCode).toBe(200);
			expect(detail.json().data.requiredAssets).toEqual(item.requiredAssets);
			const updated = await request(owner, 'PATCH', `/${p.id}`, { title: 'Asset summary' });
			expect(updated.statusCode).toBe(200);
			expect(updated.json().data.requiredAssets).toEqual(item.requiredAssets);
			return item.requiredAssets;
		}
		expect(await summary()).toEqual(none);
		await db.storageBucket.createMany({ data: [{ bucket: 'pcu-public', visibility: 'PUBLIC' }, { bucket: 'pcu-protected', visibility: 'PROTECTED' }], skipDuplicates: true });
		await db.asset.create({ data: { projectId: p.id, kind: 'GAME', status: 'READY', representations: { create: { role: 'ORIGINAL', state: 'READY', bucket: 'pcu-protected', objectKey: `protected/${p.id}/game.zip`, mimeType: 'application/zip' } } } });
		const poster = await db.asset.create({ data: { projectId: p.id, kind: 'POSTER', status: 'READY', representations: { create: (['ORIGINAL', 'CARD_480', 'DISPLAY_960'] as const).map(role => ({ role, state: 'READY', bucket: 'pcu-public', objectKey: `public/images/${p.id}/${role}.webp`, mimeType: 'image/webp', width: 1200, height: 800 })) } } });
		await db.project.update({ where: { id: p.id }, data: { posterAssetId: poster.id } });
		const video = await db.asset.create({ data: { projectId: p.id, kind: 'VIDEO', status: 'READY', videoSortOrder: 0, representations: { create: [
			{ role: 'ORIGINAL', state: 'READY', bucket: 'pcu-protected', objectKey: `protected/${p.id}/video.mp4`, mimeType: 'video/mp4' },
			{ role: 'PLAYBACK', state: 'VERIFYING', bucket: 'pcu-protected', objectKey: `protected/${p.id}/playback.mp4`, mimeType: 'video/mp4' },
		] } } });
		const upload = await db.assetUploadSession.create({ data: {
			projectId: p.id, userId: owner.id, kind: 'WEBGL', state: 'UPLOADING', originalName: 'web.zip', totalBytes: 100n,
			partSizeBytes: 100, totalParts: 1, bucket: 'pcu-protected', objectKey: `protected/${p.id}/upload.zip`,
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'a'.repeat(64), sourceIdentityBlockSizeBytes: 1048576,
			sourceIdentityBlockManifest: ['a'.repeat(64)], expiresAt: new Date(Date.now() + 3600000),
		} });
		expect(await summary()).toEqual({ ...none, nativeBuild: { ready: true, processing: false, failed: false }, poster: { ready: true, processing: false, failed: false }, video: { ready: false, processing: true, failed: false }, webBuild: { ready: false, processing: true, failed: false }, readyCount: 2 });
		await db.assetUploadSession.update({ where: { id: upload.id }, data: { state: 'REJECTED' } });
		await db.assetRepresentation.updateMany({ where: { assetId: video.id, role: 'PLAYBACK' }, data: { state: 'FAILED' } });
		expect(await summary()).toMatchObject({ webBuild: { ready: false, processing: false, failed: true }, video: { ready: false, processing: false, failed: true } });
		await db.assetRepresentation.updateMany({ where: { assetId: video.id, role: 'PLAYBACK' }, data: { state: 'READY' } });
		const source = await db.asset.create({ data: { projectId: p.id, kind: 'WEBGL', status: 'READY', representations: { create: { role: 'WEBGL_SOURCE', state: 'READY', bucket: 'pcu-protected', objectKey: `protected/${p.id}/source.zip`, mimeType: 'application/zip' } } }, include: { representations: true } });
		const deployment = await db.webglDeployment.create({ data: { projectId: p.id, sourceRepresentationId: source.representations[0]!.id, state: 'READY', publicBucket: 'pcu-public', publicPrefix: `public/${p.id}/webgl/`, entryObjectKey: `public/${p.id}/webgl/index.html`, objectManifest: { version: 1, objects: [{ objectKey: `public/${p.id}/webgl/index.html`, sizeBytes: 10, mimeType: 'text/html', checksumSha256: 'a'.repeat(64) }] } } });
		await db.project.update({ where: { id: p.id }, data: { currentWebglDeploymentId: deployment.id } });
		await db.assetUploadSession.create({ data: { ...upload, sourceIdentityBlockManifest: ['a'.repeat(64)], completionResult: undefined, id: randomUUID(), objectKey: `protected/${p.id}/retry.zip`, state: 'READY', createdAt: new Date(Date.now() + 1000) } });
		expect(await summary()).toMatchObject({ readyCount: 4, complete: true, webBuild: { ready: true, processing: false, failed: false } });
		const strangerList = await request(stranger, 'GET', '');
		expect(strangerList.statusCode).toBe(200);
		expect(strangerList.json().data.items).toEqual([]);
		expect((await request(stranger, 'GET', `/${p.id}`)).statusCode).toBe(403);
	});
	it('rejects a write whose route check passed before concurrent year closure', async () => {
		const p = await project();
		let signalLocked!: () => void, releaseClosure!: () => void;
		const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
		const release = new Promise<void>((resolve) => { releaseClosure = resolve; });
		const closure = db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT id FROM exhibitions WHERE id = ${exhibitionId} FOR UPDATE`;
			signalLocked(); await release;
			await tx.exhibition.update({ where: { id: exhibitionId }, data: { isModificationEnabled: false } });
		}, { timeout: 10000 });
		await locked;
		const pending = request(owner, 'PATCH', `/${p.id}`, { title: 'Must not commit' }).then((response) => response);
		try {
			let waiting = false;
			for (let i = 0; i < 100 && !waiting; i++) {
				const rows = await db.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%exhibitions%') AS waiting`;
				waiting = rows[0]?.waiting === true;
				if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(waiting).toBe(true);
		} finally { releaseClosure(); }
		await closure;
		expect((await pending).statusCode).toBe(403);
		expect((await db.project.findUniqueOrThrow({ where: { id: p.id } })).title).toBe('Before');
	});
	it('excludes private staging containers from owner/admin project lists, detail and exhibition counts', async () => {
		await db.exhibition.update({ where: { id: exhibitionId }, data: { isModificationEnabled: false } });
		const p = await project();
		const changes = createProjectChangeService(createProjectChangeRepository(db));
		const draft = await changes.create(owner, p.id, { kind: 'EDIT', reason: 'Add a private image' });
		const staged = await changes.update(owner, draft.id, { manifest: [{ kind: 'IMAGE', slot: 'image:0', clientToken: 'x'.repeat(32) }] });
		expect(staged.stagingProjectId).not.toBeNull();
		for (const actor of [owner, admin]) {
			const list = await request(actor, 'GET', `?year=2098&limit=100`);
			const items = AdminProjectListResponseSchema.parse(list.json().data).items;
			expect(items.some((item) => item.id === p.id)).toBe(true);
			expect(items.some((item) => item.id === staged.stagingProjectId)).toBe(false);
			expect((await request(actor, 'GET', `/${staged.stagingProjectId}`)).statusCode).toBe(404);
		}
		const exhibition = await createExhibitionRepository(db).findExhibitionByIdWithCount(exhibitionId);
		const count = await db.project.count({ where: { exhibitionId, changeRequestDraft: null } });
		expect(exhibition?._count.projects).toBe(count);
	});

});
