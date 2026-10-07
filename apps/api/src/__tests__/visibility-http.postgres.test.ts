import { createAssetUploadRepository } from '../modules/asset-upload/repository.js';
import type { AssetUploadSessionRecord } from '../modules/asset-upload/ports.js';
import { createFileAccessController } from '../modules/file-access/controller.js';
import { createFileAccessRepository } from '../modules/file-access/repository.js';
import { defaultTestEnv } from './helpers/app-mocks.js';
import { createProjectChangeController } from '../modules/project-change/controller.js';
import { createProjectChangeService } from '../modules/project-change/service.js';
import { createProjectChangeRepository } from '../modules/project-change/repository.js';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PublicProjectDetailResponseSchema, PublicYearListResponseSchema, ProjectChangeValuesSchema, type Visibility } from '@pcu/contracts';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { Actor } from '../application/http-input.js';
import { createIsolatedMigratedDatabase } from './helpers/isolated-migrated-database.js';
import { registerAuth } from '../plugins/auth.js';
import { AppError } from '../shared/errors.js';
import { registerRouteSchemas } from '../shared/http-route-schemas.js';
import { createPublicController } from '../modules/public/controller.js';
import { createPublicService } from '../modules/public/service.js';
import { createPublicRepository } from '../modules/public/repository.js';
import { createYearController } from '../modules/admin/year/controller.js';
import { createExhibitionService } from '../modules/admin/year/service.js';
import { createExhibitionRepository } from '../modules/admin/year/repository.js';
import { createProjectController } from '../modules/admin/project/controller.js';
import { createProjectCrudRepository } from '../modules/admin/project/crud.repository.js';
import { createProjectService } from '../modules/admin/project/service.js';
import { createProjectSerializer } from '../modules/admin/project/serializer.js';
import { createProjectAccessService } from '../modules/admin/project-access.service.js';
import { createProjectAccessRepository } from '../modules/admin/project-access.repository.js';
import { assertStatusTransition } from '../modules/admin/project/project-status.service.js';

const visibilities: Visibility[] = ['PUBLIC', 'AUTHENTICATED', 'STAFF'];
describe.runIf(process.env['RUN_POSTGRES_INTEGRATION'] === 'true')('visibility authenticated HTTP boundary', () => {
	let db: PrismaClient, app: FastifyInstance;
	let database: Awaited<ReturnType<typeof createIsolatedMigratedDatabase>>;
	let owner: Actor, member: Actor, stranger: Actor, operator: Actor, admin: Actor;
	const cookies = new Map<number, string>();
	beforeAll(async () => {
		database = await createIsolatedMigratedDatabase(process.env['DATABASE_URL']!); db = database.createClient();
		async function user(role: Actor['role']): Promise<Actor> {
			const row = await db.user.create({ data: { googleSub: randomUUID(), email: `${randomUUID()}@test.invalid`, role } });
			const session = await db.authSession.create({ data: { userId: row.id, expiresAt: new Date(Date.now() + 3600000) } });
			cookies.set(row.id, `sid=${session.id}`); return { id: row.id, role };
		}
		owner = await user('USER'); member = await user('USER'); stranger = await user('USER'); operator = await user('OPERATOR'); admin = await user('ADMIN');
		app = Fastify(); app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler); await app.register(cookie);
		await registerAuth(app, {
			config: { SESSION_COOKIE_NAME: 'sid', SESSION_IDLE_MS: 3600000, SESSION_TOUCH_MIN_INTERVAL_MS: 3600000, COOKIE_SECURE: false, COOKIE_SAME_SITE: 'lax', CORS_ALLOWED_ORIGINS: ['http://localhost:5173'] },
			clock: { now: () => new Date() }, logger: app.log,
			sessions: { find: (id) => db.authSession.findUnique({ where: { id }, include: { user: true } }), delete: async (id) => { await db.authSession.delete({ where: { id } }); }, touch: async (id, at) => { await db.authSession.update({ where: { id }, data: { lastSeenAt: at } }); } },
		});
		app.setErrorHandler((error, _request, reply) => { reply.status(error instanceof AppError ? error.statusCode : (typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 500)).send({ ok: false, error: { code: error instanceof AppError ? error.code : 'ERROR', message: error instanceof Error ? error.message : 'Error' } }); });
		registerRouteSchemas(app);
		await app.register(createFileAccessController(createFileAccessRepository(db), {
			...defaultTestEnv, LOG_LEVEL: 'error', GOOGLE_CLIENT_IDS: [...defaultTestEnv.GOOGLE_CLIENT_IDS], CORS_ALLOWED_ORIGINS: [...defaultTestEnv.CORS_ALLOWED_ORIGINS], API_PUBLIC_URL: 'http://localhost:3000', PUBLIC_ASSET_ORIGIN: 'http://localhost:3904',
			S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT: 'http://localhost:3906', S3_BUCKET_PUBLIC: 'pcu-public',
			S3_BUCKET_PROTECTED: 'pcu-protected', SESSION_COOKIE_NAME: 'sid',
			FILE_GATEWAY_SECRET: 'visibility-upload-race-secret-32chars',
		}), { prefix: '/api' });
		await app.register(createProjectChangeController(createProjectChangeService(createProjectChangeRepository(db)), 'me'), { prefix: '/api/me' });
		await app.register(createPublicController({ service: createPublicService({ apiPublicUrl: 'http://localhost:3000', repository: createPublicRepository(db) }) }), { prefix: '/api/public' });
		await app.register(createYearController({ service: createExhibitionService({ posterBucket: 'pcu-public', repository: createExhibitionRepository(db), wakeDeletionWorker() {} }) }), { prefix: '/api/admin' });
		const repository = createProjectCrudRepository(db);
		await app.register(createProjectController({ service: createProjectService({ repository, serializeProjectDetail: createProjectSerializer('http://localhost:3000').serializeProjectDetail, deletionBuckets: { publicBucket: 'pcu-public', protectedBucket: 'pcu-protected' }, abortMultipart: async () => {}, wakeDeletionWorker() {}, wakeMaintenance() {}, logger: app.log }), access: createProjectAccessService(createProjectAccessRepository(db)), status: { assertTransition: assertStatusTransition, bulkUpdate: async (ids, status) => ({ updated: (await repository.bulkUpdateStatus(ids, status)).count }) } }), { prefix: '/api/admin' });
	});
	afterAll(async () => { await app?.close(); await database?.close(); });
	function request(actor: Actor | null, url: string, method: 'GET' | 'PATCH' | 'POST' = 'GET', payload?: Record<string, unknown>) {
		return app.inject({ method, url, headers: { origin: 'http://localhost:5173', ...(actor ? { cookie: cookies.get(actor.id)! } : {}) }, ...(payload ? { payload } : {}) });
	}
	it('enforces every exhibition/project audience combination, owner/member exceptions and visible counts', async () => {
		for (const exhibitionVisibility of visibilities) {
			const exhibition = await db.exhibition.create({ data: { year: 2097, title: randomUUID(), visibility: exhibitionVisibility } });
			for (const visibility of visibilities) {
				const p = await db.project.create({ data: { exhibitionId: exhibition.id, creatorId: owner.id, title: visibility, slug: randomUUID(), status: 'PUBLISHED', visibility, members: { create: { name: 'Member', userId: member.id } } } });
				for (const actor of [null, stranger, owner, member, operator, admin]) {
					const staff = actor?.role === 'ADMIN' || actor?.role === 'OPERATOR';
					const accepts = (v: Visibility) => v === 'PUBLIC' || (v === 'AUTHENTICATED' && actor !== null) || staff;
					const related = actor?.id === owner.id || actor?.id === member.id;
					const allowed = related || (accepts(exhibitionVisibility) && accepts(visibility));
					const detail = await request(actor, `/api/public/projects/${p.id}`);
					expect(detail.statusCode, `${exhibitionVisibility}/${visibility}/${actor?.role ?? 'anonymous'}/${related}`).toBe(allowed ? 200 : 404);
					expect(detail.headers['cache-control']).toBe('private, no-store');
					if (allowed) expect(PublicProjectDetailResponseSchema.parse(detail.json().data)).toMatchObject({ visibility, exhibitionVisibility, canChangeVisibility: related || staff });
					const list = await request(actor, `/api/public/exhibitions/${exhibition.id}/projects`);
					expect(list.statusCode).toBe(accepts(exhibitionVisibility) ? 200 : 404);
					const years = await request(actor, '/api/public/years');
					const item = PublicYearListResponseSchema.parse(years.json().data).items.find((e) => e.id === exhibition.id);
					if (!accepts(exhibitionVisibility)) expect(item).toBeUndefined();
					else expect(item?.projectCount).toBe(list.json().data.items.length);
				}
			}
		}
	});
	it('keeps archival independent from audience through authenticated PATCH and anonymous GET', async () => {
		const exhibition = await db.exhibition.create({ data: { year: 2091, title: randomUUID(), visibility: 'PUBLIC' } });
		const project = await db.project.create({ data: { exhibitionId: exhibition.id, creatorId: owner.id, title: 'Archive audience', slug: randomUUID(), status: 'PUBLISHED', visibility: 'PUBLIC', members: { create: { name: 'Member', userId: member.id } } } });
		const adminUrl = `/api/admin/projects/${project.id}`;
		const publicUrl = `/api/public/projects/${project.id}`;
		async function anonymousRead(visible: boolean, status: 'PUBLISHED' | 'ARCHIVED') {
			const detail = await request(null, publicUrl);
			expect(detail.statusCode, detail.body).toBe(visible ? 200 : 404);
			if (visible) expect(PublicProjectDetailResponseSchema.parse(detail.json().data)).toMatchObject({ status, visibility: 'PUBLIC' });
			for (const url of [`/api/public/exhibitions/${exhibition.id}/projects`, '/api/public/years/2091/projects']) {
				const list = await request(null, url);
				expect(list.statusCode, list.body).toBe(200);
				expect(list.json().data.items.map((p: { id: number }) => p.id)).toEqual(visible ? [project.id] : []);
			}
			const years = await request(null, '/api/public/years');
			expect(PublicYearListResponseSchema.parse(years.json().data).items.find((e) => e.id === exhibition.id)?.projectCount).toBe(visible ? 1 : 0);
		}
		await anonymousRead(true, 'PUBLISHED');
		const archived = await request(operator, adminUrl, 'PATCH', { status: 'ARCHIVED' });
		expect(archived.statusCode, archived.body).toBe(200);
		expect(archived.json().data).toMatchObject({ status: 'ARCHIVED', visibility: 'PUBLIC' });
		await anonymousRead(true, 'ARCHIVED');
		for (const status of ['ARCHIVED', 'PUBLISHED'] as const) {
			const statusWrite = await request(operator, adminUrl, 'PATCH', { status });
			expect(statusWrite.statusCode, statusWrite.body).toBe(200);
			for (const visibility of ['STAFF', 'AUTHENTICATED', 'PUBLIC'] as const) {
				const saved = await request(operator, adminUrl, 'PATCH', { visibility });
				expect(saved.statusCode, saved.body).toBe(200);
				expect(saved.json().data).toMatchObject({ status, visibility });
				expect((await request(operator, adminUrl)).json().data).toMatchObject({ status, visibility });
				await anonymousRead(visibility === 'PUBLIC', status);
				for (const actor of [owner, member, operator, admin, stranger]) {
					expect((await request(actor, publicUrl)).statusCode).toBe(actor === stranger && visibility === 'STAFF' ? 404 : 200);
				}
			}
		}
		const denied = await request(stranger, adminUrl, 'PATCH', { visibility: 'STAFF' });
		expect(denied.statusCode).toBe(403);
		await anonymousRead(true, 'PUBLISHED');
		const restricted = await request(admin, `/api/admin/exhibitions/${exhibition.id}`, 'PATCH', { visibility: 'STAFF' });
		expect(restricted.statusCode, restricted.body).toBe(200);
		expect((await request(operator, adminUrl, 'PATCH', { visibility: 'PUBLIC' })).statusCode).toBe(200);
		expect((await request(null, publicUrl)).statusCode).toBe(404);
		expect((await request(null, `/api/public/exhibitions/${exhibition.id}/projects`)).statusCode).toBe(404);
	});
	it('keeps inaccessible exhibitions out of admin selectors; year slug cannot fall through', async () => {
		const exhibition = await db.exhibition.create({ data: { year: 2096, title: 'Hidden', visibility: 'STAFF' } });
		const p = await db.project.create({ data: { exhibitionId: exhibition.id, creatorId: owner.id, title: 'Own hidden', slug: randomUUID(), status: 'ARCHIVED' } });
		expect((await request(owner, '/api/admin/exhibitions')).json().data.items.some((e: {id:number}) => e.id === exhibition.id)).toBe(false);
		expect((await request(owner, `/api/admin/projects/${p.id}`)).statusCode).toBe(200);
		expect((await request(owner, `/api/public/projects/${p.slug}?year=2096`)).statusCode).toBe(404);
		expect((await request(admin, `/api/public/projects/${p.slug}?year=2001`)).statusCode).toBe(404);
	});
	it('serializes empty exhibitions, create defaults and partial updates without widening draft access', async () => {
		const created = await request(admin, '/api/admin/exhibitions', 'POST', { year: 2094, title: randomUUID() });
		expect(created.statusCode).toBe(201);
		const id = created.json().data.id as number;
		expect((await db.exhibition.findUniqueOrThrow({ where: { id } })).visibility).toBe('PUBLIC');
		expect((await request(operator, `/api/admin/exhibitions/${id}`, 'PATCH', { visibility: 'AUTHENTICATED' })).json().data.visibility).toBe('AUTHENTICATED');
		expect((await request(admin, `/api/admin/exhibitions/${id}`, 'PATCH', { title: 'Preserved' })).json().data.visibility).toBe('AUTHENTICATED');
		expect((await request(owner, `/api/admin/exhibitions/${id}`, 'PATCH', { visibility: 'PUBLIC' })).statusCode).toBe(403);
		const empty = await request(stranger, '/api/public/years/2094/projects');
		expect(empty.json().data).toMatchObject({ items: [], empty: true });
		const draft = await db.project.create({ data: { exhibitionId: id, creatorId: owner.id, title: 'Draft', slug: randomUUID(), status: 'DRAFT' } });
		for (const actor of [null, owner, member, admin]) expect((await request(actor, `/api/public/projects/${draft.id}`)).statusCode).toBe(404);
		expect((await request(owner, `/api/admin/projects/${draft.id}`)).statusCode).toBe(200);
		const unrelated = await db.project.create({ data: { exhibitionId: id, creatorId: stranger.id, title: 'Other', slug: randomUUID(), status: 'PUBLISHED', visibility: 'STAFF' } });
		expect((await request(owner, `/api/public/projects/${unrelated.id}`)).statusCode).toBe(404);
	});
	it.each(['project', 'exhibition'] as const)('retains %s restriction when upload READY commit waits for a concurrent visibility change', async (scope) => {
		await db.storageBucket.upsert({ where: { bucket: 'pcu-protected' }, create: { bucket: 'pcu-protected', visibility: 'PROTECTED' }, update: {} });
		const exhibition = await db.exhibition.create({ data: { year: 2092, title: randomUUID() } });
		const project = await db.project.create({ data: { exhibitionId: exhibition.id, creatorId: owner.id, title: 'Upload race', slug: randomUUID(), status: 'PUBLISHED' } });
		const uploads = createAssetUploadRepository(db);
		const id = randomUUID();
		// Production allocation occurs before policy changes. Exercise the actual
		// worker READY transaction after validation, without mocking the repository.
		await uploads.createAllocating({
			id, projectId: project.id, exhibitionId: null, userId: owner.id, actorRole: owner.role,
			kind: 'DOCUMENT', originalName: 'race.txt', declaredMimeType: 'text/plain', totalBytes: 10n,
			partSizeBytes: 10, totalParts: 1, bucket: 'pcu-protected', objectKey: `protected/uploads/${id}/source`, generation: 1,
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'a'.repeat(64), sourceIdentityBlockSizeBytes: 1_048_576,
			sourceIdentityBlockManifest: 'e30=', expiresAt: new Date(Date.now() + 60_000), submissionItemId: null,
		});
		const session = await db.assetUploadSession.update({ where: { id }, data: { state: 'VERIFYING', validationLeaseToken: 'race-lease', validationLeaseUntil: new Date(Date.now() + 60_000) } });
		let locked!: (pid: number) => void, release!: () => void;
		const blockerReady = new Promise<number>((resolve) => { locked = resolve; });
		const releaseBlocker = new Promise<void>((resolve) => { release = resolve; });
		const tightening = db.$transaction(async (tx) => {
			if (scope === 'project') await tx.$queryRaw`SELECT id FROM projects WHERE id = ${project.id} FOR UPDATE`;
			else await tx.$queryRaw`SELECT id FROM exhibitions WHERE id = ${exhibition.id} FOR UPDATE`;
			const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
			locked(backend!.pid);
			await releaseBlocker;
			if (scope === 'project') await tx.project.update({ where: { id: project.id }, data: { visibility: 'STAFF', version: { increment: 1 } } });
			else await tx.exhibition.update({ where: { id: exhibition.id }, data: { visibility: 'STAFF' } });
		}, { timeout: 10_000 });
		const blockerPid = await blockerReady;
		const completion = uploads.commitGameReady({ session: session as AssetUploadSessionRecord, token: 'race-lease', mimeType: 'text/plain' });
		try {
			let waiting = false;
			for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
				// This backend must actually block the final upload transaction; merely
				// starting two promises would not demonstrate the intended interleaving.
				const [row] = await db.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND ${blockerPid} = ANY(pg_blocking_pids(pid))) AS waiting`;
				waiting = row?.waiting === true;
				if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(waiting).toBe(true);
		} finally {
			release();
			// Drain both transactions even when the lock observation assertion fails.
			await Promise.allSettled([tightening, completion]);
		}
		await tightening;
		const committed = await completion;
		const stored = await db.project.findUniqueOrThrow({ where: { id: project.id }, include: { exhibition: true } });
		expect(scope === 'project' ? stored.visibility : stored.exhibition.visibility).toBe('STAFF');
		expect((await db.assetUploadSession.findUniqueOrThrow({ where: { id } })).state).toBe('READY');
		expect(await db.assetRepresentation.findUniqueOrThrow({ where: { id: committed.representationId } })).toMatchObject({ state: 'READY', bucket: 'pcu-protected', objectKey: session.objectKey });
		for (const actor of [null, stranger]) {
			expect((await request(actor, `/api/public/projects/${project.id}`)).statusCode).toBe(404);
			expect((await request(actor, '/api/file-access', 'POST', { url: `http://localhost:3906/pcu-protected/${session.objectKey}` })).statusCode).toBe(403);
		}
		const detail = await request(owner, `/api/admin/projects/${project.id}`);
		expect(detail.statusCode).toBe(200);
		expect(detail.json().data).toMatchObject({ visibility: stored.visibility, exhibitionVisibility: stored.exhibition.visibility, attachments: [{ assetId: committed.assetId, originalName: 'race.txt' }] });
		expect((await request(owner, '/api/file-access', 'POST', { url: `http://localhost:3906/pcu-protected/${session.objectKey}` })).statusCode).toBe(200);
		const rawFile = await app.inject({ url: '/api/internal/file-access', headers: { 'x-pcu-gateway-secret': 'visibility-upload-race-secret-32chars', 'x-pcu-file-kind': 'protected', 'x-pcu-file-uri': `/pcu-protected/${session.objectKey}` } });
		expect(rawFile.statusCode).toBe(403);
	});
	it('rechecks relations and lock for visibility writes; locked requests reject visibility', async () => {
		const exhibition = await db.exhibition.create({ data: { year: 2095, title: randomUUID() } });
		const p = await db.project.create({ data: { exhibitionId: exhibition.id, creatorId: owner.id, title: 'Editable', slug: randomUUID(), status: 'PUBLISHED', members: { create: { name: 'Member', userId: member.id } } } });
		for (const actor of [owner, member]) expect((await request(actor, `/api/admin/projects/${p.id}`, 'PATCH', { visibility: 'STAFF' })).json().data).toMatchObject({ visibility: 'STAFF', canChangeVisibility: true });
		await db.projectMember.deleteMany({ where: { projectId: p.id } });
		expect((await request(member, `/api/admin/projects/${p.id}`, 'PATCH', { visibility: 'PUBLIC' })).statusCode).toBe(403);
		await db.exhibition.update({ where: { id: exhibition.id }, data: { isModificationEnabled: false } });
		expect((await request(owner, `/api/admin/projects/${p.id}`, 'PATCH', { visibility: 'PUBLIC' })).statusCode).toBe(403);
		expect((await request(owner, `/api/admin/projects/${p.id}`)).json().data.canChangeVisibility).toBe(false);
		for (const actor of [operator, admin]) expect((await request(actor, `/api/admin/projects/${p.id}`, 'PATCH', { visibility: 'AUTHENTICATED' })).statusCode).toBe(200);
		expect(ProjectChangeValuesSchema.safeParse({ visibility: 'PUBLIC' }).success).toBe(false);
		const change = await request(owner, `/api/me/projects/${p.id}/change-requests`, 'POST', { kind: 'EDIT', reason: 'Update metadata' });
		expect(change.statusCode, change.body).toBe(201);
		const bypass = await request(owner, `/api/me/change-requests/${change.json().data.id}`, 'PATCH', { changes: { visibility: 'PUBLIC' } });
		expect(bypass.statusCode).toBe(400);
		expect((await db.project.findUniqueOrThrow({ where: { id: p.id } })).visibility).toBe('AUTHENTICATED');
		expect((await request(admin, `/api/admin/projects/${p.id}`, 'PATCH', { title: 'Preserve' })).json().data.visibility).toBe('AUTHENTICATED');
		expect((await request(admin, `/api/admin/projects/${p.id}`, 'PATCH', { visibility: 'INVALID' })).statusCode).toBe(400);
	});
});
