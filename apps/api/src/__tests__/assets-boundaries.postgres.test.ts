import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '../generated/prisma/client.js';
import { buildApp } from '../app.js';
import { createProductionBackendContext } from '../backend-context.js';
import { createAssetDeletionUnitOfWork } from '../modules/assets/deletion.repository.js';
import { createAssetsRepository } from '../modules/assets/repository.js';
import { createAssetsService } from '../modules/assets/service.js';
import { planAssetDeletion } from '../modules/assets/deletion.policy.js';
import { createProjectAccessService } from '../modules/admin/project-access.service.js';
import { createProjectAccessRepository } from '../modules/admin/project-access.repository.js';
import { createProjectCrudRepository } from '../modules/admin/project/crud.repository.js';
import { createProjectChangeService } from '../modules/project-change/service.js';
import { createProjectChangeRepository } from '../modules/project-change/repository.js';
import { createAssetUploadRepository } from '../modules/asset-upload/repository.js';
import { createIsolatedMigratedDatabase } from './helpers/isolated-migrated-database.js';
import { defaultTestEnv } from './helpers/app-mocks.js';
import { createTestUploadLifecycleRuntime } from './helpers/upload-lifecycle.js';

const enabled = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';
describe.runIf(enabled)('assets atomic deletion and full app HTTP boundaries', () => {
 let database: Awaited<ReturnType<typeof createIsolatedMigratedDatabase>>;
 let db: PrismaClient, app: FastifyInstance;
 let context: Awaited<ReturnType<typeof createProductionBackendContext>>;
 let owner: number, stranger: number, member: number, admin: number, operator: number, exhibitionId: number;
 const sessions = new Map<number, string>();
 const wake = vi.fn();
 const presign = vi.fn(async (bucket: string, key: string, options?: { responseContentDisposition?: string }) =>
  `http://localhost:3906/${bucket}/${encodeURIComponent(key)}?disposition=${encodeURIComponent(options?.responseContentDisposition ?? '')}`);
 const headers = (id: number) => ({ cookie: `sid=${sessions.get(id)}`, origin: 'http://localhost:5173' });
 const actor = () => ({ id: owner, role: 'USER' as const });
 const service = () => createAssetsService({ protectedBucket: 'pcu-protected', repository: createAssetsRepository(db), deletion: createAssetDeletionUnitOfWork(db), checkDownloadLimit: async () => {}, wakeDeletionWorker: wake, logger: { error: vi.fn() } });
 beforeAll(async () => {
  database = await createIsolatedMigratedDatabase(process.env['DATABASE_URL']!); db = database.createClient();
  const ids: number[] = [];
  for (const role of ['USER', 'USER', 'USER', 'ADMIN', 'OPERATOR'] as const) {
   const user = await db.user.create({ data: { googleSub: randomUUID(), email: `${randomUUID()}@test.invalid`, role } }); ids.push(user.id);
   const session = await db.authSession.create({ data: { userId: user.id, expiresAt: new Date(Date.now() + 3_600_000) } }); sessions.set(user.id, session.id);
  }
  [owner, stranger, member, admin, operator] = ids as [number, number, number, number, number];
  exhibitionId = (await db.exhibition.create({ data: { year: 2099, title: randomUUID(), isModificationEnabled: true } })).id;
  await db.storageBucket.createMany({ data: [{ bucket: 'pcu-public', visibility: 'PUBLIC' }, { bucket: 'pcu-protected', visibility: 'PROTECTED' }], skipDuplicates: true });
  const lifecycle = createTestUploadLifecycleRuntime(); lifecycle.wakeDeletionWorker = wake;
  context = await createProductionBackendContext({ ...defaultTestEnv, LOG_LEVEL: 'error', PUBLIC_ASSET_ORIGIN: 'http://files.test', GOOGLE_CLIENT_IDS: [...defaultTestEnv.GOOGLE_CLIENT_IDS], CORS_ALLOWED_ORIGINS: [...defaultTestEnv.CORS_ALLOWED_ORIGINS], DATABASE_URL: process.env['DATABASE_URL']!, FILE_GATEWAY_SECRET: 'integration-gateway-secret-32-characters' }, {
   resources: { prisma: { value: db, ownership: 'borrowed' }, uploadLifecycle: { value: lifecycle, ownership: 'borrowed' } },
   factories: { protectedDownloadPresigner: () => ({ presign }) },
  });
  await context.start(); app = await buildApp({ context }); await app.ready();
 });
 afterAll(async () => { await app?.close(); await database?.close(); });
 async function fixture(kind: 'VIDEO' | 'IMAGE' | 'GAME' = 'VIDEO', count = 3, status: 'PUBLISHED' | 'DRAFT' = 'PUBLISHED') {
  const project = await db.project.create({ data: { exhibitionId, creatorId: owner, slug: randomUUID(), title: 'Boundary game', status, members: { create: { userId: member, name: 'Member', studentId: '2026001', sortOrder: 0 } } } });
  const assets = [];
  for (let index = 0; index < count; index++) assets.push(await db.asset.create({ data: {
   projectId: project.id, kind, status: 'READY', originalName: kind === 'VIDEO' ? 'video.mov' : 'game.zip', videoSortOrder: kind === 'VIDEO' ? index : null,
   representations: { create: [{ role: 'ORIGINAL', bucket: kind === 'IMAGE' ? 'pcu-public' : 'pcu-protected', objectKey: `${kind === 'IMAGE' ? 'public/images/' : ''}${randomUUID()}/original`, state: 'READY', mimeType: 'application/octet-stream', sizeBytes: 1n },
    ...(kind === 'IMAGE' ? (['CARD_480', 'DISPLAY_960'] as const).map(role => ({ role, bucket: 'pcu-public', objectKey: `public/images/${randomUUID()}/${role}`, state: 'READY' as const, mimeType: 'image/webp', sizeBytes: 1n })) : []),
    ...(kind === 'VIDEO' ? [{ role: 'PLAYBACK' as const, bucket: 'pcu-protected', objectKey: `${randomUUID()}/playback`, state: 'READY' as const, mimeType: 'video/mp4', sizeBytes: 1n }] : [])] },
  }, include: { representations: true } }));
  if (kind === 'IMAGE') await db.project.update({ where: { id: project.id }, data: { posterAssetId: assets[0]!.id } });
  return { project, assets, first: assets[0]! };
 }
 async function state(projectId: number) {
  return { project: await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { posterAssetId: true, version: true } }),
   assets: await db.asset.findMany({ where: { projectId }, orderBy: { id: 'asc' }, select: { id: true, status: true, videoSortOrder: true } }) };
 }
 async function stagingFixture() {
  const f = await fixture('GAME', 1);
  await db.exhibition.update({ where: { id: exhibitionId }, data: { isModificationEnabled: false } });
  const changes = createProjectChangeService(createProjectChangeRepository(db));
  const request = await changes.create(actor(), f.project.id, { kind: 'EDIT', reason: 'Replace game' });
  const clientToken = 's'.repeat(32);
  const stage = await changes.update(actor(), request.id, { manifest: [{ kind: 'GAME', slot: 'game', clientToken }] });
  return { stageId: stage.stagingProjectId!, itemId: stage.items[0]!.id, clientToken };
 }
 it('rejects staging mutations at HTTP access, transaction recheck and atomic deletion for owner and staff', async () => {
  const f = await stagingFixture();
  // Opening the exhibition lets the owner pass the ordinary ownership policy.
  await db.exhibition.update({ where: { id: exhibitionId }, data: { isModificationEnabled: true } });
  const asset = await db.asset.create({ data: { projectId: f.stageId, kind: 'GAME', status: 'READY',
   representations: { create: { role: 'ORIGINAL', bucket: 'pcu-protected', objectKey: `staging/${randomUUID()}`, state: 'READY', mimeType: 'application/zip' } },
  }, include: { representations: true } });
  const before = await state(f.stageId);
  const message = 'Staged change-request projects cannot be modified through project routes';
  for (const id of [owner, admin, operator]) {
   const currentActor = { id, role: id === admin ? 'ADMIN' as const : id === operator ? 'OPERATOR' as const : 'USER' as const };
   const response = await app.inject({ method: 'PATCH', url: `/api/admin/projects/${f.stageId}`, headers: headers(id), payload: { title: 'Blocked' } });
   expect(response.statusCode).toBe(403); expect(response.json().error).toMatchObject({ code: 'FORBIDDEN', message });
   // Bypass the route check to exercise the locked transaction's own decision.
   await expect(createProjectCrudRepository(db).updateProject(f.stageId, { title: 'Blocked' }, currentActor)).rejects.toMatchObject({ statusCode: 403, message });
   const deletion = await app.inject({ method: 'DELETE', url: `/api/admin/assets/${asset.id}`, headers: headers(id) });
   expect(deletion.statusCode).toBe(403); expect(deletion.json().error).toMatchObject({ code: 'FORBIDDEN', message });
  }
  expect(await state(f.stageId)).toEqual(before);
  expect(await db.orphanObject.count({ where: { storageKey: asset.representations[0]!.objectKey } })).toBe(0);
 });
 it('allows the active staging owner through upload access and allocation while the source exhibition is closed', async () => {
  try {
   const f = await stagingFixture();
   const access = createProjectAccessService(createProjectAccessRepository(db));
   await expect(access.loadProjectForUpload(actor(), f.stageId)).resolves.toMatchObject({ isChangeRequestDraft: true, isModificationEnabled: false });
   for (const id of [stranger, admin, operator]) {
    await expect(access.loadProjectForUpload({ id, role: id === admin ? 'ADMIN' : id === operator ? 'OPERATOR' : 'USER' }, f.stageId)).rejects.toMatchObject({ statusCode: 403 });
   }
   const uploads = createAssetUploadRepository(db);
   const input = { id: randomUUID(), projectId: f.stageId, exhibitionId: null, userId: owner, kind: 'GAME' as const,
    originalName: 'game.zip', declaredMimeType: 'application/zip', totalBytes: 10n, partSizeBytes: 10, totalParts: 1,
    bucket: 'pcu-protected', objectKey: `staging/${randomUUID()}`, generation: 1,
    sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'a'.repeat(64), sourceIdentityBlockSizeBytes: 1_048_576, sourceIdentityBlockManifest: 'e30=',
    expiresAt: new Date(Date.now() + 60_000), submissionItemId: f.itemId, submissionClientToken: f.clientToken,
   };
   // Allocation invokes the upload policy again against locked source/stage rows.
   await expect(uploads.createAllocating({ ...input, userId: admin, actorRole: 'ADMIN' })).rejects.toMatchObject({ statusCode: 403 });
   await expect(uploads.createAllocating(input)).resolves.toMatchObject({ projectId: f.stageId, userId: owner, state: 'ALLOCATING' });
   const request = await db.projectChangeRequest.findUniqueOrThrow({ where: { stagingProjectId: f.stageId } });
   await db.projectChangeRequest.update({ where: { id: request.id }, data: { state: 'PENDING' } });
   await expect(access.loadProjectForUpload(actor(), f.stageId)).rejects.toMatchObject({ statusCode: 403 });
   await expect(uploads.createAllocating({ ...input, id: randomUUID() })).rejects.toMatchObject({ statusCode: 403 });
  } finally {
   await db.exhibition.update({ where: { id: exhibitionId }, data: { isModificationEnabled: true } });
  }
 });
 it.each(['VIDEO', 'IMAGE'] as const)('rolls back %s status, poster, order and version when an outbox write fails', async kind => {
  const f = await fixture(kind); const before = await state(f.project.id);
  await db.$executeRawUnsafe(`CREATE FUNCTION fail_asset_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected outbox failure' USING ERRCODE='23514'; END $$`);
  await db.$executeRawUnsafe('CREATE TRIGGER fail_asset_outbox BEFORE INSERT ON orphan_objects FOR EACH ROW EXECUTE FUNCTION fail_asset_outbox()');
  wake.mockClear();
  try {
   await expect(service().deleteAsset(f.first.id, actor())).rejects.toThrow('injected outbox failure');
   expect(await state(f.project.id)).toEqual(before);
   expect(await db.orphanObject.count({ where: { storageKey: { in: f.first.representations.map(r => r.objectKey) } } })).toBe(0);
   expect(wake).not.toHaveBeenCalled();
  } finally { await db.$executeRawUnsafe('DROP TRIGGER fail_asset_outbox ON orphan_objects'); await db.$executeRawUnsafe('DROP FUNCTION fail_asset_outbox()'); }
 });
 it('commits concurrent duplicate deletes once and requeues resolved outbox rows without increasing version', async () => {
  const f = await fixture();
  await Promise.all([service().deleteAsset(f.first.id, actor()), service().deleteAsset(f.first.id, actor())]);
  const after = await state(f.project.id);
  expect(after.project).toEqual({ posterAssetId: null, version: f.project.version + 1 });
  expect(after.assets[0]!.status).toBe('DELETED'); expect(after.assets.slice(1).map(a => a.videoSortOrder)).toEqual([0, 1]);
  const where = { storageKey: { in: f.first.representations.map(r => r.objectKey) } };
  expect(await db.orphanObject.count({ where })).toBe(2);
  await db.orphanObject.updateMany({ where, data: { state: 'RESOLVED', resolvedAt: new Date() } });
  await service().deleteAsset(f.first.id, actor());
  expect(await state(f.project.id)).toEqual(after);
  expect((await db.orphanObject.findMany({ where })).every(row => row.state === 'PENDING')).toBe(true);
 });
 it('finishes existing DELETING assets without a second version increment and accepts empty representations', async () => {
  const f = await fixture('IMAGE', 1);
  await db.$transaction(async tx => {
   await tx.project.update({ where: { id: f.project.id }, data: { posterAssetId: null } });
   await tx.asset.update({ where: { id: f.first.id }, data: { status: 'DELETING' } });
  });
  await db.assetRepresentation.deleteMany({ where: { assetId: f.first.id } });
  await service().deleteAsset(f.first.id, actor());
  expect(await state(f.project.id)).toMatchObject({ project: { posterAssetId: null, version: f.project.version }, assets: [{ status: 'DELETED' }] });
 });
 it.each(['PENDING', 'FINALIZING'] as const)('preserves all deletion state during %s submission', async submissionState => {
  const f = await fixture('VIDEO', 3, 'DRAFT');
  await db.projectSubmission.create({ data: { projectId: f.project.id, actorId: owner, state: submissionState } });
  const before = await state(f.project.id);
  await expect(service().deleteAsset(f.first.id, actor())).rejects.toMatchObject({ statusCode: 409 });
  expect(await state(f.project.id)).toEqual(before);
 });
 it('re-reads the snapshot and reruns policy after a real PostgreSQL serialization failure', async () => {
  const f = await fixture(); const versions: number[] = [];
  await db.$executeRawUnsafe('CREATE SEQUENCE asset_retry_sequence');
  await db.$executeRawUnsafe(`CREATE FUNCTION retry_asset_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF nextval('asset_retry_sequence') = 1 THEN RAISE EXCEPTION 'retry transaction' USING ERRCODE='40001'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe('CREATE TRIGGER retry_asset_outbox BEFORE INSERT ON orphan_objects FOR EACH ROW EXECUTE FUNCTION retry_asset_outbox()');
  try {
   await createAssetDeletionUnitOfWork(db).run(f.first.id, actor(), async tx => {
    versions.push(tx.snapshot.project.version); await tx.applyDeletion(planAssetDeletion(tx.snapshot, actor()));
   });
   expect(versions).toEqual([f.project.version, f.project.version]);
   expect((await state(f.project.id)).project.version).toBe(f.project.version + 1);
  } finally {
   await db.$executeRawUnsafe('DROP TRIGGER retry_asset_outbox ON orphan_objects'); await db.$executeRawUnsafe('DROP FUNCTION retry_asset_outbox()'); await db.$executeRawUnsafe('DROP SEQUENCE asset_retry_sequence');
  }
 });
 it('rechecks permission after waiting for a concurrent project owner change', async () => {
  const f = await fixture('IMAGE', 1);
  let unlock!: () => void; let locked!: () => void;
  const ready = new Promise<void>(resolve => { locked = resolve; }); const release = new Promise<void>(resolve => { unlock = resolve; });
  const change = db.$transaction(async tx => {
   await tx.$queryRaw`SELECT id FROM projects WHERE id = ${f.project.id} FOR UPDATE`;
   await tx.project.update({ where: { id: f.project.id }, data: { creatorId: stranger } }); locked(); await release;
  });
  await ready;
  let probed!: () => void; const probe = new Promise<void>(resolve => { probed = resolve; });
  const observed = db.$extends({ query: { asset: { async findUnique({ args, query }) { const row = await query(args); probed(); return row; } } } });
  const deletion = createAssetDeletionUnitOfWork(observed as unknown as PrismaClient).run(f.first.id, actor(), tx => tx.applyDeletion(planAssetDeletion(tx.snapshot, actor())));
  const result = expect(deletion).rejects.toMatchObject({ statusCode: 403 });
  await probe; unlock(); await change; await result;
  expect((await state(f.project.id)).assets[0]!.status).toBe('READY');
 });
 it('uses authenticated full-app routes for redirect, shared canonical issuance, gateway filename and deletion 204', async () => {
  const f = await fixture('GAME', 1); const check = vi.spyOn(context.protectedDownloads, 'check'); check.mockClear(); presign.mockClear();
  const route = `/api/assets/${f.first.id}/download`;
  const response = await app.inject({ url: route, headers: headers(owner) });
  expect(response.statusCode).toBe(302); expect(response.headers.location).toMatch(/^http:\/\/localhost:3906\/file\/[a-f0-9]{64}$/);
  expect(response.headers['cache-control']).toBe('private, no-store'); expect(response.headers['referrer-policy']).toBe('no-referrer');
  expect(check).toHaveBeenCalledTimes(1); expect(presign).not.toHaveBeenCalled();
  const issued = await app.inject({ method: 'POST', url: '/api/file-access', headers: headers(owner), payload: { url: defaultTestEnv.API_PUBLIC_URL + route } });
  expect(issued.statusCode).toBe(200); expect(issued.json().data.url).toBe(response.headers.location); expect(check).toHaveBeenCalledTimes(2);
  const grant = issued.json().data;
  const gatewayHeaders = { 'x-pcu-gateway-secret': 'integration-gateway-secret-32-characters', 'x-pcu-file-kind': 'protected', 'x-pcu-file-uri': new URL(grant.url).pathname };
  const gateway = await app.inject({ url: '/api/internal/file-access', headers: gatewayHeaders });
  expect(gateway.statusCode).toBe(204); expect(presign).toHaveBeenCalledWith('pcu-protected', f.first.representations[0]!.objectKey, expect.objectContaining({ responseContentDisposition: expect.stringContaining('attachment;') }));
  await db.fileAccessToken.update({ where: { id: grant.token }, data: { expiresAt: new Date(0) } });
  expect((await app.inject({ url: '/api/internal/file-access', headers: gatewayHeaders })).statusCode).toBe(403);
  const deleted = await app.inject({ method: 'DELETE', url: `/api/admin/assets/${f.first.id}`, headers: headers(owner) });
  expect(deleted.statusCode).toBe(204); expect(deleted.body).toBe(''); expect((await state(f.project.id)).assets[0]!.status).toBe('DELETED');
  check.mockRestore();
 });
 it('preserves public-image limiter scope and URL issuance guest denial', async () => {
  const f = await fixture('IMAGE', 1); const route = `/api/assets/${f.first.id}/download`;
  const check = vi.spyOn(context.protectedDownloads, 'check'); check.mockClear();
  try {
   expect((await app.inject({ url: route, headers: headers(owner) })).statusCode).toBe(302);
   expect(check).toHaveBeenCalledTimes(1);
   const issued = await app.inject({ method: 'POST', url: '/api/file-access', headers: headers(owner), payload: { url: defaultTestEnv.API_PUBLIC_URL + route } });
   expect(issued.statusCode).toBe(200); expect(issued.json().data.token).toBeNull();
   expect(check).toHaveBeenCalledTimes(1);
   const poster = await db.asset.create({ data: { exhibitionId, kind: 'POSTER', status: 'READY',
    representations: { create: (['ORIGINAL', 'CARD_480', 'DISPLAY_960'] as const).map(role => ({ role, bucket: 'pcu-public', objectKey: `public/images/${randomUUID()}/${role}`, state: 'READY', mimeType: 'image/webp' })) },
   } });
   const posterGrant = await app.inject({ method: 'POST', url: '/api/file-access', headers: headers(owner), payload: { url: defaultTestEnv.API_PUBLIC_URL + `/api/assets/${poster.id}/download` } });
   expect(posterGrant.statusCode).toBe(200); expect(posterGrant.json().data.token).toBeNull();
   expect(check).toHaveBeenCalledTimes(1);
   const privateAsset = await fixture('GAME', 1, 'DRAFT');
   const denied = await app.inject({ method: 'POST', url: '/api/file-access', headers: { origin: 'http://localhost:5173' }, payload: { url: defaultTestEnv.API_PUBLIC_URL + `/api/assets/${privateAsset.first.id}/download` } });
   expect(denied.statusCode).toBe(403);
  } finally { check.mockRestore(); }
 });
 it('enforces roles, empty/multiple representations, original/playback, bans and rate limits at HTTP boundary', async () => {
  const f = await fixture('VIDEO', 1, 'DRAFT'); const route = `/api/assets/${f.first.id}/download`;
  expect((await app.inject({ url: route })).statusCode).toBe(401);
  expect((await app.inject({ url: route, headers: headers(stranger) })).statusCode).toBe(403);
  for (const id of [owner, member, admin, operator]) for (const variant of ['original', 'playback']) {
   expect((await app.inject({ url: route + '?variant=' + variant, headers: headers(id) })).statusCode).toBe(302);
  }
  await db.asset.update({ where: { id: f.first.id }, data: { status: 'PROCESSING' } });
  await db.assetRepresentation.deleteMany({ where: { assetId: f.first.id } });
  expect((await app.inject({ url: route, headers: headers(owner) })).statusCode).toBe(404);
  const game = await fixture('GAME', 1); const gameRoute = `/api/assets/${game.first.id}/download`;
  context.protectedDownloads.addBan('192.0.2.12');
  expect((await app.inject({ url: gameRoute, remoteAddress: '192.0.2.12', headers: headers(owner) })).statusCode).toBe(403);
  for (let i = 0; i < 30; i++) expect((await app.inject({ url: gameRoute, headers: headers(owner) })).statusCode).toBe(302);
  const limited = await app.inject({ url: gameRoute, headers: headers(owner) });
  expect(limited.statusCode).toBe(429); expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
 });
});
