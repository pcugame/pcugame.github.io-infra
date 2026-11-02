import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createIsolatedMigratedDatabase } from './helpers/isolated-migrated-database.js';
import { registerAuth } from '../plugins/auth.js';
import { registerRouteSchemas } from '../shared/http-route-schemas.js';
import { createAwardController } from '../modules/awards/controller.js';
import { createAwardRepository } from '../modules/awards/repository.js';
import { createAwardService } from '../modules/awards/service.js';
import { createPublicController } from '../modules/public/controller.js';
import { createPublicRepository } from '../modules/public/repository.js';
import { createPublicService } from '../modules/public/service.js';

// Real repositories, session authentication, route schemas and JSON serialization.
describe.runIf(process.env['RUN_POSTGRES_INTEGRATION'] === 'true')('award image HTTP delivery', () => {
 let database: Awaited<ReturnType<typeof createIsolatedMigratedDatabase>>;
 let db: PrismaClient;
 let app: FastifyInstance;
 let exhibitionId: number;
 let projectId: number;
 let assetId: number;
 let sessionCookie: string;
 const origin = 'https://assets.example.test';
 const bucket = 'pcu-public';
 beforeAll(async () => {
  database = await createIsolatedMigratedDatabase(process.env['DATABASE_URL']!);
  db = database.createClient();
  const user = await db.user.create({ data: { googleSub: randomUUID(), email: 'award@test.invalid', role: 'ADMIN' } });
  const session = await db.authSession.create({ data: { userId: user.id, expiresAt: new Date(Date.now() + 3600000) } });
  sessionCookie = `sid=${session.id}`;
  exhibitionId = (await db.exhibition.create({ data: { year: 2098, title: 'Awards', visibility: 'PUBLIC' } })).id;
  projectId = (await db.project.create({ data: { exhibitionId, creatorId: user.id, title: 'Winner', slug: randomUUID(), status: 'PUBLISHED', publicationStatus: 'PUBLIC', visibility: 'PUBLIC' } })).id;
  await db.storageBucket.upsert({ where: { bucket }, create: { bucket, visibility: 'PUBLIC' }, update: {} });
  await db.storageBucket.upsert({ where: { bucket: 'pcu-protected' }, create: { bucket: 'pcu-protected', visibility: 'PROTECTED' }, update: {} });
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(cookie);
  await registerAuth(app, {
   config: { SESSION_COOKIE_NAME: 'sid', SESSION_IDLE_MS: 3600000, SESSION_TOUCH_MIN_INTERVAL_MS: 3600000, COOKIE_SECURE: false, COOKIE_SAME_SITE: 'lax', CORS_ALLOWED_ORIGINS: ['http://localhost:5173'] },
   clock: { now: () => new Date() }, logger: app.log,
   sessions: {
    find: id => db.authSession.findUnique({ where: { id }, include: { user: true } }),
    delete: async id => { await db.authSession.delete({ where: { id } }); },
    touch: async (id, at) => { await db.authSession.update({ where: { id }, data: { lastSeenAt: at } }); },
   },
  });
  registerRouteSchemas(app);
  await app.register(createAwardController(createAwardService(createAwardRepository(db), origin, bucket)), { prefix: '/api/admin' });
  await app.register(createPublicController({ service: createPublicService({ apiPublicUrl: 'http://localhost:3000', publicAssetOrigin: origin, publicBucket: bucket, repository: createPublicRepository(db) }) }), { prefix: '/api/public' });
 });
 afterAll(async () => { await app?.close(); await database?.close(); });
 const adminUrl = () => `/api/admin/exhibitions/${exhibitionId}/awards`;
 async function request(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: object) {
  const response = await app.inject({ method, url, headers: { cookie: sessionCookie, origin: 'http://localhost:5173' }, ...(payload ? { payload } : {}) });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().data;
 }
 async function publicAwards(expected: unknown[]) {
  for (const url of [`/api/public/years/2098/projects`, `/api/public/exhibitions/${exhibitionId}/projects`, `/api/public/projects/${projectId}`]) {
   const response = await app.inject({ method: 'GET', url });
   expect(response.statusCode, response.body).toBe(200);
   const data = response.json().data;
   expect(data.items ? data.items[0].awards : data.awards).toEqual(expected);
  }
 }
 it('returns rendition URLs in authenticated reads/writes and public cards/details, including empty awards', async () => {
  expect(await request('GET', adminUrl())).toMatchObject({ items: [], assets: [] });
  await publicAwards([]);
  assetId = (await db.asset.create({ data: { exhibitionId, kind: 'IMAGE', status: 'READY', originalName: 'medal.png', representations: { create: [
   { role: 'ORIGINAL', state: 'READY', bucket, objectKey: 'awards/original.png', mimeType: 'image/png', sizeBytes: 4096, width: 1920, height: 1920 },
   { role: 'DISPLAY_960', state: 'READY', bucket, objectKey: 'awards/display.webp', mimeType: 'image/webp', sizeBytes: 2048, width: 960, height: 960 },
   { role: 'CARD_480', state: 'READY', bucket, objectKey: 'awards/card 480.webp', mimeType: 'image/webp', sizeBytes: 1024, width: 480, height: 480 },
  ] } } })).id;
  const created = await request('POST', adminUrl(), { expectedVersion: 0, name: 'Winner', builtinKey: null, assetId });
  const imageUrl = `${origin}/awards/card%20480.webp`;
  expect(created.items[0].imageUrl).toBe(imageUrl);
  expect(created.assets[0].imageUrl).toBe(imageUrl);
  const awardId = created.items[0].id;
  const assigned = await request('PUT', `/api/admin/projects/${projectId}/awards`, { expectedVersion: 1, awardIds: [awardId] });
  expect(assigned.items[0]).toMatchObject({ imageUrl, projectIds: [projectId] });
  expect(await request('GET', adminUrl())).toEqual(assigned);
  const { projectIds: _projectIds, ...award } = assigned.items[0];
  await publicAwards([award]);

  const cleared = await request('PUT', `/api/admin/projects/${projectId}/awards`, { expectedVersion: 2, awardIds: [] });
  expect(cleared.items[0].projectIds).toEqual([]);
  await publicAwards([]);
 });
 it('persists all laurel colors across authenticated writes/reads and public collections/details', async () => {
  let state = await request('GET', adminUrl());
  const awardId = state.items[0].id;
  state = await request('PUT', `/api/admin/projects/${projectId}/awards`, { expectedVersion: state.version, awardIds: [awardId] });
  for (const builtinKey of ['laurel-gold', 'laurel-silver', 'laurel-bronze', 'laurel-slate']) {
   state = await request('PATCH', `${adminUrl()}/${awardId}`, { expectedVersion: state.version, name: 'Winner', builtinKey, assetId: null });
   expect(state.items[0]).toMatchObject({ builtinKey, assetId: null });
   expect(state.items[0].imageUrl).toBeUndefined();
   expect(await request('GET', adminUrl())).toEqual(state);
   const { projectIds: _recipients, ...award } = state.items[0];
   await publicAwards([award]);
  }
  // A saved photo remains selectable after switching to a laurel and back.
  state = await request('PATCH', `${adminUrl()}/${awardId}`, { expectedVersion: state.version, name: 'Winner', builtinKey: null, assetId });
  expect(state.items[0].imageUrl).toBe(`${origin}/awards/card%20480.webp`);
  const { projectIds: _recipients, ...photoAward } = state.items[0];
  await publicAwards([photoAward]);
  // Creation uses the same contract and serialization as editing.
  state = await request('POST', adminUrl(), { expectedVersion: state.version, name: 'New award', builtinKey: 'laurel-gold', assetId: null });
  expect(state.items.at(-1)).toMatchObject({ builtinKey: 'laurel-gold', assetId: null });

 });

});
