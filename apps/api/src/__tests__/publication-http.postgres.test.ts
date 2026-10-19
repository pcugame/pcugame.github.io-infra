import multipart from '@fastify/multipart';
import { createMeProjectController } from '../modules/me/project/controller.js';
import { createAdminProjectMetadataController } from '../modules/admin/project/metadata.controller.js';
import { createSubmitProjectService } from '../modules/admin/project/project-submit.service.js';
import { createIdempotencyService } from '../modules/idempotency/service.js';
import { createIdempotencyRepository } from '../modules/idempotency/repository.js';
import { createProjectPublicationRepository } from '../modules/project-publication/repository.js';
import { createPublicationTransitionRepository } from '../modules/migration/publication-transition.repository.js';
import { createAssetsRepository } from '../modules/assets/repository.js';
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
import { PublicProjectDetailResponseSchema, PublicYearListResponseSchema, ProjectChangeValuesSchema } from '@pcu/contracts';
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


describe.runIf(process.env['RUN_POSTGRES_INTEGRATION'] === 'true')('publication authenticated HTTP boundary', () => {
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
		app = Fastify(); app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler); await app.register(cookie); await app.register(multipart);
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
  const metadata = { service: createSubmitProjectService({ repository, webPublicUrl: 'http://localhost:5173', idempotency: createIdempotencyService({ repository: createIdempotencyRepository(db), clock: { now: () => new Date() } }) }), route: { rateLimit: { max: 100, timeWindow: 3600000 } } };
  await app.register(createAdminProjectMetadataController(metadata), { prefix: '/api/admin' });
  await app.register(createMeProjectController(metadata), { prefix: '/api/me' });

		await app.register(createProjectController({ service: createProjectService({ repository, serializeProjectDetail: createProjectSerializer('http://localhost:3000', { publicAssetOrigin: 'http://localhost:3904', publicBucket: 'pcu-public' }).serializeProjectDetail, deletionBuckets: { publicBucket: 'pcu-public', protectedBucket: 'pcu-protected' }, abortMultipart: async () => {}, wakeDeletionWorker() {}, wakeMaintenance() {}, logger: app.log }), access: createProjectAccessService(createProjectAccessRepository(db)), status: { assertTransition: assertStatusTransition, bulkUpdate: async (ids, status) => ({ updated: (await repository.bulkUpdateStatus(ids, status)).count }) } }), { prefix: '/api/admin' });
	});
	afterAll(async () => { await app?.close(); await database?.close(); });
	function request(actor: Actor | null, url: string, method: 'GET' | 'PATCH' | 'POST' = 'GET', payload?: Record<string, unknown>) {
		return app.inject({ method, url, headers: { origin: 'http://localhost:5173', ...(actor ? { cookie: cookies.get(actor.id)! } : {}) }, ...(payload ? { payload } : {}) });
	}

 it('defaults private, serializes empty media and readiness, blocks users/operators and audits admin override', async () => {
  const exhibition = await db.exhibition.create({ data: { year: 2099, title: randomUUID() } });
  const p = await db.project.create({ data: { exhibitionId: exhibition.id, creatorId: owner.id, title: 'Private', slug: randomUUID(), status: 'PUBLISHED', members: { create: { name: 'Student', studentId: '1', userId: member.id } } } });
  expect(p.publicationStatus).toBe('PRIVATE');
  const url = `/api/admin/projects/${p.id}`;
  for (const actor of [owner, member, operator, admin]) {
   const response = await request(actor, url);
   expect(response.statusCode, response.body).toBe(200);
   expect(response.json().data).toMatchObject({ publicationStatus: 'PRIVATE', version: 1, assets: [], publicationReadiness: { ready: false, blockers: ['summary', 'platforms', 'poster', 'nativeBuild', 'video'] } });
  }
  expect((await request(stranger, url)).statusCode).toBe(403);
  expect((await request(null, `/api/public/projects/${p.id}`)).statusCode).toBe(404);
  for (const actor of [owner, operator]) {
   expect((await request(actor, url, 'PATCH', { publication: { status: 'PUBLIC', expectedVersion: 1 } })).statusCode).toBe(409);
   expect((await request(actor, url, 'PATCH', { publication: { status: 'PUBLIC', expectedVersion: 1, exceptionReason: 'Exception' } })).statusCode).toBe(403);
  }
  const published = await request(admin, url, 'PATCH', { publication: { status: 'PUBLIC', expectedVersion: 1, exceptionReason: '승인된 자료 없는 전시 작품' } });
  expect(published.statusCode, published.body).toBe(200);
  expect(published.json().data).toMatchObject({ publicationStatus: 'PUBLIC', version: 2 });
  expect(await db.publicationException.findFirst({ where: { projectId: p.id } })).toMatchObject({ actorId: admin.id, kind: 'ADMIN', projectVersion: 2, waivedItems: ['summary', 'platforms', 'poster', 'nativeBuild', 'video'] });
  expect((await request(null, `/api/public/projects/${p.id}`)).statusCode).toBe(200);
  expect((await request(owner, url, 'PATCH', { publication: { status: 'PRIVATE', expectedVersion: 1 } })).statusCode).toBe(409);
  expect((await request(owner, url, 'PATCH', { publication: { status: 'PRIVATE', expectedVersion: 2 } })).statusCode).toBe(200);
  expect((await request(null, `/api/public/projects/${p.id}`)).statusCode).toBe(404);
  const list = await request(null, `/api/public/exhibitions/${exhibition.id}/projects`);
  expect(list.json().data.items).toEqual([]);
 });
 it('keeps existing public requirements from worsening, rolls back failed changes, and excludes historical cancellation', async () => {
  const exhibition = await db.exhibition.create({ data: { year: 2098, title: randomUUID() } });
  const p = await db.project.create({ data: { exhibitionId: exhibition.id, creatorId: owner.id, title: 'Legacy', slug: randomUUID(), status: 'PUBLISHED', publicationStatus: 'PUBLIC', legacyPublication: true, summary: 'Existing summary', platforms: ['PC'], members: { create: { name: 'Student', studentId: '1' } } } });
  const url = `/api/admin/projects/${p.id}`;
  const rejected = await request(owner, url, 'PATCH', { summary: '   ' });
  expect(rejected.statusCode, rejected.body).toBe(409);
  expect(await db.project.findUnique({ where: { id: p.id } })).toMatchObject({ version: 1, summary: 'Existing summary' });
  expect((await request(owner, url, 'PATCH', { description: 'Updated' })).statusCode).toBe(200);
  const hidden = await db.project.create({ data: { exhibitionId: exhibition.id, creatorId: owner.id, title: 'Cancelled', slug: randomUUID(), hiddenCancelled: true } });
  const list = await request(admin, '/api/admin/projects');
  expect(list.json().data.items.some((row: { id: number }) => row.id === hidden.id)).toBe(false);
 });
 it('replays authenticated creation, rejects duplicate titles, permits explicit duplicates and stops a pending publish', async () => {
  const exhibition = await db.exhibition.create({ data: { year: 2096, title: randomUUID() } });
  const key = randomUUID();
  const payload = { exhibitionId: exhibition.id, title: 'Persisted request', members: [{ name: 'Student', studentId: '1' }], manifest: [] };
  const create = (requestKey: string, body = payload) => app.inject({ method: 'POST', url: '/api/admin/projects/submit', headers: { cookie: cookies.get(admin.id)!, origin: 'http://localhost:5173', 'idempotency-key': requestKey, 'content-type': 'multipart/form-data; boundary=pub-test' }, payload: `--pub-test\r\nContent-Disposition: form-data; name="payload"\r\n\r\n${JSON.stringify(body)}\r\n--pub-test--\r\n` });
  const created = await create(key);
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().data.id;
  expect((await create(key)).json().data.id).toBe(id);
  expect((await create(randomUUID())).statusCode).toBe(409);
  expect((await create(randomUUID(), { ...payload, allowDuplicateTitle: true } as typeof payload)).statusCode).toBe(201);
  const url = `/api/admin/projects/${id}`;
  expect((await request(admin, url, 'PATCH', { publication: { status: 'PUBLIC', expectedVersion: 1, exceptionReason: '파일 없는 예외 전시' } })).statusCode).toBe(200);
  const finalize = await request(admin, `${url}/submission/finalize`, 'POST');
  expect(finalize.statusCode, finalize.body).toBe(200);
  expect(await db.project.findUnique({ where: { id } })).toMatchObject({ publicationStatus: 'PRIVATE', publicationRequested: true });
  await db.storageBucket.upsert({ where: { bucket: 'pcu-public' }, create: { bucket: 'pcu-public', visibility: 'PUBLIC' }, update: {} });
  await db.storageBucket.upsert({ where: { bucket: 'pcu-protected' }, create: { bucket: 'pcu-protected', visibility: 'PROTECTED' }, update: {} });
  const worker = createProjectPublicationRepository(db);
  const job = await worker.claim({ token: 'test-worker', leaseMs: 60000 });
  expect(job).not.toBeNull();
  const validated = await worker.validatePlan(job!, 'test-worker');
  expect(validated.status, JSON.stringify(validated)).toBe('VALID');
  expect((await request(admin, url, 'PATCH', { publication: { status: 'PRIVATE', expectedVersion: 2 } })).statusCode).toBe(200);
  if (validated.status === 'VALID') expect(await worker.complete(validated.job, 'test-worker')).toBe('COMPLETED');
  expect(await db.project.findUnique({ where: { id } })).toMatchObject({ publicationStatus: 'PRIVATE' });
 });
 it('publishes verified media, serializes populated collections, and blocks deletion of the last required file', async () => {
  const exhibition = await db.exhibition.create({ data: { year: 2095, title: randomUUID() } });
  const p = await db.project.create({ data: { exhibitionId: exhibition.id, creatorId: owner.id, title: 'Complete', summary: 'Game', platforms: ['PC'], slug: randomUUID(), status: 'PUBLISHED', members: { create: { name: 'Student', studentId: '1' } } } });
  await db.storageBucket.upsert({ where: { bucket: 'pcu-public' }, create: { bucket: 'pcu-public', visibility: 'PUBLIC' }, update: {} });
  await db.storageBucket.upsert({ where: { bucket: 'pcu-protected' }, create: { bucket: 'pcu-protected', visibility: 'PROTECTED' }, update: {} });
  const poster = await db.asset.create({ data: { projectId: p.id, kind: 'POSTER', status: 'READY', originalName: 'poster.webp', representations: { create: ['ORIGINAL', 'CARD_480', 'DISPLAY_960'].map(role => ({ role: role as 'ORIGINAL' | 'CARD_480' | 'DISPLAY_960', bucket: 'pcu-public', objectKey: `public/images/${p.id}/${role}.webp`, mimeType: 'image/webp', state: 'READY', sizeBytes: 10n })) } } });
  const game = await db.asset.create({ data: { projectId: p.id, kind: 'GAME', status: 'READY', originalName: 'game.zip', representations: { create: { role: 'ORIGINAL', bucket: 'pcu-protected', objectKey: `game-${p.id}.zip`, state: 'READY', mimeType: 'application/zip', sizeBytes: 10n } } } });
  await db.asset.create({ data: { projectId: p.id, kind: 'VIDEO', status: 'READY', originalName: 'video.mp4', representations: { create: ['ORIGINAL', 'PLAYBACK'].map(role => ({ role: role as 'ORIGINAL' | 'PLAYBACK', bucket: 'pcu-protected', objectKey: `video-${p.id}-${role}.mp4`, state: 'READY', mimeType: 'video/mp4', sizeBytes: 10n })) } } });
  await db.project.update({ where: { id: p.id }, data: { posterAssetId: poster.id } });
  const response = await request(owner, `/api/admin/projects/${p.id}`, 'PATCH', { publication: { status: 'PUBLIC', expectedVersion: 1 } });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data.assets).toHaveLength(3);
  expect(response.json().data.publicationReadiness.ready).toBe(true);
  await expect(createAssetsRepository(db).claimAssetForDeletion(game.id, owner)).rejects.toThrow('필수 자료');
  expect((await request(owner, `/api/admin/projects/${p.id}`, 'PATCH', { publication: { status: 'PRIVATE', expectedVersion: 2 } })).statusCode).toBe(200);
  await expect(createAssetsRepository(db).claimAssetForDeletion(game.id, owner)).resolves.toMatchObject({ id: game.id });
 });
 it('conditionally transitions reviewed empty IDs and preserves changed candidates across repeat execution', async () => {
  const exhibition = await db.exhibition.create({ data: { year: 2094, title: randomUUID() } });
  for (const id of [214, 215]) await db.project.create({ data: { id, exhibitionId: exhibition.id, creatorId: owner.id, title: `Candidate ${id}`, slug: `candidate-${id}`, status: 'PUBLISHED', publicationStatus: 'PUBLIC', legacyPublication: true } });
  const repository = createPublicationTransitionRepository(db);
  const preview = await repository.preview();
  await db.project.update({ where: { id: 215 }, data: { summary: 'Edited after preview', version: { increment: 1 } } });
  expect(await repository.apply(preview.candidates)).toEqual([{ id: 214, result: 'private' }, { id: 215, result: 'changed-skipped' }]);
  expect(await repository.apply(preview.candidates)).toEqual([{ id: 214, result: 'already-applied' }, { id: 215, result: 'changed-skipped' }]);
  expect(await db.project.findUnique({ where: { id: 215 } })).toMatchObject({ publicationStatus: 'PUBLIC', summary: 'Edited after preview' });
 });

});
