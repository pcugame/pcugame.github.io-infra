import { createDiagnosticRepository } from '../modules/webgl-play/diagnostic-repository.js';
import { createDiagnosticService } from '../modules/webgl-play/diagnostic-service.js';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebglNetworkRequestSchema, WebglNetworkRequestListSchema } from '@pcu/contracts';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { Env } from '../config/env.js';
import { AppError } from '../shared/errors.js';
import { registerAuth } from '../plugins/auth.js';
import { registerCsrf } from '../plugins/csrf.js';
import { registerRouteSchemas } from '../shared/http-route-schemas.js';
import { createIsolatedMigratedDatabase } from './helpers/isolated-migrated-database.js';
import { createWebglNetworkRepository } from '../modules/webgl-network/repository.js';
import { createWebglNetworkService } from '../modules/webgl-network/service.js';
import { createWebglNetworkController } from '../modules/webgl-network/controller.js';
import { createWebglPlayRepository } from '../modules/webgl-play/repository.js';
import { createWebglPlayService } from '../modules/webgl-play/service.js';
import { createWebglPlayController } from '../modules/webgl-play/controller.js';
import { createFileAccessRepository } from '../modules/file-access/repository.js';
import { createFileAccessController } from '../modules/file-access/controller.js';

const enabled = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';
describe.runIf(enabled)('WebGL external policy authenticated PostgreSQL boundary', () => {
 let database: Awaited<ReturnType<typeof createIsolatedMigratedDatabase>>, db: PrismaClient, app: FastifyInstance;
 let logs = '';
 let projectId: number, exhibitionId: number, sid: string, adminSid: string, outsiderSid: string, memberSid: string, operatorSid: string;
 let owner: number, admin: number, member: number;
 let playRepository: ReturnType<typeof createWebglPlayRepository>;
 const webOrigin = 'https://web.fixture.example', apiOrigin = 'https://api.fixture.example', gameOrigin = 'https://games.fixture.example';
 const secret = 'fixture-gateway-secret-at-least-32chars';
 const external = 'https://scores.example.com';
 const body = (origin = external) => ({ origin, purpose: 'Read and write game scores', mode: origin.startsWith('wss:') ? 'WSS' : 'HTTPS', cors: `Allow ${gameOrigin}; use a per-game account, never a site session` });
 const config = {
  SESSION_SECRET: 'diagnostic-test-secret-at-least-32-characters', WEBGL_PLAY_ENABLED: true, WEBGL_EXTERNAL_CONNECTIONS_ENABLED: true, CORS_ALLOWED_ORIGINS: [webOrigin],
  API_PUBLIC_URL: apiOrigin, WEB_PUBLIC_URL: webOrigin, PUBLIC_ASSET_ORIGIN: gameOrigin,
  S3_ENDPOINT: 'https://garage.fixture.example', S3_PUBLIC_SIGNING_ENDPOINT: 'https://uploads.fixture.example',
  S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT: 'https://downloads.fixture.example', S3_BUCKET_PUBLIC: 'public', S3_BUCKET_PROTECTED: 'protected',
  SESSION_COOKIE_NAME: 'sid', SESSION_IDLE_MS: 3600000, SESSION_TOUCH_MIN_INTERVAL_MS: 300000,
  COOKIE_SECURE: true, COOKIE_SAME_SITE: 'none', FILE_GATEWAY_SECRET: secret,
 } as Env;
 function request(method: 'GET' | 'POST', url: string, session = sid, payload?: unknown, origin = webOrigin) {
  return app.inject({ method, url, headers: { origin, ...(session ? { cookie: `sid=${session}` } : {}), ...(payload === undefined ? {} : { 'content-type': 'application/json' }) }, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
 }
 const list = (session = sid) => request('GET', `/api/me/projects/${projectId}/webgl-network-requests`, session);
 const create = (origin = external, session = sid) => request('POST', `/api/me/projects/${projectId}/webgl-network-requests`, session, body(origin));
 const review = (id: string, action: string, session = adminSid) => request('POST', `/api/admin/webgl-network-requests/${id}/${action}`, session, { reason: `Reviewed ${action}: configured service and origin verified` });
 const issue = (diagnostics = false) => app.inject({ method: 'POST', url: '/api/webgl-play/sessions', headers: {
  origin: apiOrigin, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', cookie: `sid=${sid}`,
 }, payload: { projectId, diagnostics } });
 type Grant = { id: string; controlSecret: string; iframeUrl: string };
 const renew = (grant: Grant) => app.inject({ method: 'POST', url: `/api/webgl-play/sessions/${grant.id}/renew`, headers: {
  origin: apiOrigin, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', cookie: `sid=${sid}`, 'x-pcu-play-control': grant.controlSecret,
 }, payload: { visible: true } });
 const gate = (grant: Grant) => app.inject({ url: '/api/internal/file-access', headers: {
  'x-pcu-gateway-secret': secret, 'x-pcu-file-kind': 'public', 'x-pcu-file-uri': new URL(grant.iframeUrl).pathname, 'x-pcu-file-method': 'GET',
 } });
 async function grant(): Promise<Grant> { const response = await issue(); expect(response.statusCode, response.body).toBe(200); return response.json().data; }
 async function approved(origin = external) { const result = await create(origin); expect(result.statusCode, result.body).toBe(201); const id = result.json().data.id; expect((await review(id, 'approve')).statusCode).toBe(200); return id as string; }
 beforeAll(async () => {
  database = await createIsolatedMigratedDatabase(process.env['DATABASE_URL']!); db = database.createClient();
  async function user(role: 'USER' | 'ADMIN' | 'OPERATOR') {
   const row = await db.user.create({ data: { googleSub: randomUUID(), email: `${randomUUID()}@fixture.invalid`, role } });
   const session = await db.authSession.create({ data: { userId: row.id, expiresAt: new Date(Date.now() + 3600000) } });
   return { id: row.id, sid: session.id };
  }
  const a = await user('USER'), b = await user('ADMIN'), c = await user('USER'), d = await user('USER');
  operatorSid = (await user('OPERATOR')).sid;
  owner = a.id; sid = a.sid; admin = b.id; adminSid = b.sid; outsiderSid = c.sid; member = d.id; memberSid = d.sid;
  await db.storageBucket.createMany({ data: [{ bucket: 'public', visibility: 'PUBLIC' }, { bucket: 'protected', visibility: 'PROTECTED' }] });
  app = Fastify({ logger: { level: 'trace', stream: { write: (line: string) => { logs += line; } } } }); app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler); registerRouteSchemas(app);
  await app.register(cookie);
  await registerAuth(app, { config, clock: { now: () => new Date() }, logger: app.log, sessions: {
   find: id => db.authSession.findUnique({ where: { id }, include: { user: true } }),
   touch: (id, lastSeenAt) => db.authSession.update({ where: { id }, data: { lastSeenAt } }),
   delete: id => db.authSession.deleteMany({ where: { id } }),
  } });
  await registerCsrf(app, config);
  app.setErrorHandler((error: FastifyError, _request, reply) => reply.status(error instanceof AppError ? error.statusCode : error.validation ? 400 : error.statusCode ?? 500).send({ ok: false, error: { code: error instanceof AppError ? error.code : 'ERROR', message: error.message } }));
  const network = createWebglNetworkService(createWebglNetworkRepository(db), config);
  await app.register(createWebglNetworkController(network, 'me'), { prefix: '/api/me' });
  await app.register(createWebglNetworkController(network, 'admin'), { prefix: '/api/admin' });
  playRepository = createWebglPlayRepository(db);
  const play = createWebglPlayService(playRepository, config, createDiagnosticService(createDiagnosticRepository(db)));
  await app.register(createWebglPlayController(play, config));
  await app.register(createFileAccessController(createFileAccessRepository(db), config, undefined, undefined, undefined, play.resolveRuntime), { prefix: '/api' });
 });
 beforeEach(async () => {
  config.WEBGL_EXTERNAL_CONNECTIONS_ENABLED = true;
  const exhibition = await db.exhibition.create({ data: { year: 2000 + Math.floor(Math.random() * 10000), title: randomUUID() } }); exhibitionId = exhibition.id;
  const project = await db.project.create({ data: { creatorId: owner, exhibitionId, title: 'Network fixture', slug: randomUUID(), status: 'PUBLISHED', members: { create: { userId: member, name: 'Member' } } } }); projectId = project.id;
  const asset = await db.asset.create({ data: { projectId, kind: 'WEBGL', representations: { create: { bucket: 'protected', objectKey: `${randomUUID()}.zip`, role: 'WEBGL_SOURCE', state: 'READY', mimeType: 'application/zip' } } }, include: { representations: true } });
  const id = randomUUID(), prefix = `public/webgl/${projectId}/${id}/`;
  await db.webglDeployment.create({ data: { id, projectId, sourceRepresentationId: asset.representations[0]!.id, publicBucket: 'public', publicPrefix: prefix, entryObjectKey: prefix + 'index.html', state: 'READY', objectManifest: { version: 1, objects: ['index.html', 'worker.js'].map(path => ({ objectKey: prefix + path, sizeBytes: '0', mimeType: path.endsWith('.js') ? 'application/javascript' : 'text/html', contentEncoding: null, etag: 'fixture-etag', checksumSha256: null })) } } });
  await db.project.update({ where: { id: projectId }, data: { currentWebglDeploymentId: id } });
 });
 afterAll(async () => { await app?.close(); await database?.close(); });
 it('serializes empty and populated owner/admin lists and audited review responses', async () => {
  const emptyAdmin = await request('GET', '/api/admin/webgl-network-requests', adminSid);
  expect(WebglNetworkRequestListSchema.parse(emptyAdmin.json().data).items).toEqual([]);
  const empty = await list(); expect(empty.statusCode).toBe(200); expect(WebglNetworkRequestListSchema.parse(empty.json().data)).toEqual({ items: [], gameOrigin, policyVersion: 0 });
  const created = await create(); expect(created.statusCode, created.body).toBe(201); expect(WebglNetworkRequestSchema.parse(created.json().data).events).toEqual([]);
  const id = created.json().data.id;
  const response = await review(id, 'approve'); expect(response.statusCode, response.body).toBe(200);
  const reviewed = WebglNetworkRequestSchema.parse(response.json().data); expect(reviewed.state).toBe('APPROVED'); expect(reviewed.events[0]).toMatchObject({ action: 'APPROVE', actorId: admin, policyVersion: 1 });
  const ownerList = WebglNetworkRequestListSchema.parse((await list()).json().data); expect(ownerList.policyVersion).toBe(1); expect(ownerList.items[0]).toEqual(reviewed);
  const adminList = await request('GET', '/api/admin/webgl-network-requests', adminSid); expect(adminList.statusCode).toBe(200); expect(WebglNetworkRequestListSchema.parse(adminList.json().data).policyVersion).toBeNull();
 });
 it('checks ownership, linked membership, exhibition closure, authentication and review role', async () => {
  expect((await list(outsiderSid)).statusCode).toBe(403); expect((await create(external, outsiderSid)).statusCode).toBe(403);
  expect((await list('')).statusCode).toBe(401); expect((await list(sid)).statusCode).toBe(200);
  expect((await create(external, memberSid)).statusCode).toBe(201);
  const row = (await list()).json().data.items[0]; expect((await review(row.id, 'approve', sid)).statusCode).toBe(403);
  expect((await request('POST', `/api/me/projects/${projectId}/webgl-network-requests`, sid, body('https://next.example.com'), apiOrigin)).statusCode).toBe(403);
  await db.exhibition.update({ where: { id: exhibitionId }, data: { isModificationEnabled: false } });
  expect((await create('https://closed.example.com')).statusCode).toBe(403);
  expect((await create('https://closed-admin.example.com', adminSid)).statusCode).toBe(403);
  await db.project.update({ where: { id: projectId }, data: { creatorId: admin } });
  expect((await create('https://closed-owner-admin.example.com', adminSid)).statusCode).toBe(403);
 });
 it('rejects staging projects and preserves owner reads after exhibition closure', async () => {
  const stage = await db.project.create({ data: { creatorId: owner, exhibitionId, title: 'Staging', slug: randomUUID(), status: 'DRAFT' } });
  await db.projectChangeRequest.create({ data: { projectId, originalProjectId: projectId, projectTitle: 'Network fixture', actorId: owner,
   kind: 'EDIT', baseVersion: 1, before: {}, changes: {}, reason: 'Staged edit', stagingProjectId: stage.id } });
  expect((await request('POST', `/api/me/projects/${stage.id}/webgl-network-requests`, sid, body())).statusCode).toBe(403);
  expect((await request('GET', `/api/me/projects/${stage.id}/webgl-network-requests`)).statusCode).toBe(404);
  await db.exhibition.update({ where: { id: exhibitionId }, data: { isModificationEnabled: false } });
  expect((await list()).statusCode).toBe(200);
 });
 it('rejects privileged origins including changed ports and secure socket variants', async () => {
  for (const origin of [apiOrigin, gameOrigin, webOrigin, 'https://api.fixture.example:8443', 'wss://downloads.fixture.example', 'https://garage.fixture.example']) expect((await create(origin)).statusCode, origin).toBe(400);
  expect((await request('POST', `/api/me/projects/${projectId}/webgl-network-requests`, sid, { ...body(), cors: '' })).statusCode).toBe(400);
 });
 it('serializes concurrent duplicate requests and enforces partial uniqueness independently', async () => {
  const responses = await Promise.all([create(), create()]); expect(responses.map(result => result.statusCode).sort()).toEqual([201, 409]);
  await expect(db.webglNetworkRequest.create({ data: { ...body(), mode: 'HTTPS', projectId, originalProjectId: projectId, projectTitle: 'Duplicate', requesterId: owner } })).rejects.toMatchObject({ code: 'P2002' });
 });
 it('serializes concurrent approvals at the sixteen-origin policy budget', async () => {
  for (let index = 0; index < 15; index++) await approved(`https://service${index}.example.com`);
  const first = (await create('https://sixteenth.example.com')).json().data.id;
  const second = (await create('https://seventeenth.example.com')).json().data.id;
  const results = await Promise.all([review(first, 'approve'), review(second, 'approve')]);
  expect(results.map(result => result.statusCode).sort()).toEqual([200, 409]);
  const session = await grant(); const snapshot = await db.webglPlaySession.findUniqueOrThrow({ where: { id: session.id } });
  expect(snapshot.approvedOrigins).toHaveLength(16); expect(snapshot.policyVersion).toBe(16);
 });
 it('applies approvals to new sessions and restricts them to connect-src', async () => {
  const old = await grant(); await approved(); const next = await grant();
  const oldResponse = await gate(old), nextResponse = await gate(next); expect(oldResponse.statusCode).toBe(204); expect(nextResponse.statusCode).toBe(204);
  expect(oldResponse.headers['x-pcu-runtime-csp']).not.toContain(external);
  const directives = String(nextResponse.headers['x-pcu-runtime-csp']).split(';').map(value => value.trim());
  expect(directives.find(value => value.startsWith('connect-src '))).toContain(external);
  expect(directives.filter(value => !value.startsWith('connect-src ')).join(';')).not.toContain(external);
  expect((await renew(old)).statusCode).toBe(200);
 });
 it('permanently invalidates affected snapshots on revoke, including after reapproval', async () => {
  const id = await approved(), old = await grant(); expect((await gate(old)).statusCode).toBe(204);
  const worker = { ...old, iframeUrl: old.iframeUrl.replace('index.html', 'worker.js') };
  expect((await gate(worker)).statusCode).toBe(204);
  expect((await review(id, 'revoke')).statusCode).toBe(200); expect((await gate(old)).statusCode).toBe(403); expect((await renew(old)).statusCode).toBe(403);
  expect((await gate(worker)).statusCode).toBe(403);
  await approved(); expect((await gate(old)).statusCode).toBe(403); expect((await renew(old)).statusCode).toBe(403);
  expect((await gate(await grant())).statusCode).toBe(204);
  const events = await db.webglNetworkReviewEvent.findMany({ where: { requestId: id }, orderBy: { policyVersion: 'asc' } });
  expect(events.map(event => event.action)).toEqual(['APPROVE', 'REVOKE']);
  await expect(db.webglNetworkReviewEvent.update({ where: { id: events[0]!.id }, data: { reason: 'tampered' } })).rejects.toThrow('append-only');
  await expect(db.webglNetworkReviewEvent.delete({ where: { id: events[0]!.id } })).rejects.toThrow('append-only');
 });
 it('rejects invalid transitions and records rejection without policy changes', async () => {
  const id = (await create()).json().data.id; expect((await review(id, 'revoke')).statusCode).toBe(409);
  const rejected = await review(id, 'reject'); expect(rejected.statusCode).toBe(200); expect(rejected.json().data.events[0]).toMatchObject({ action: 'REJECT', policyVersion: 0 });
  expect((await review(id, 'approve')).statusCode).toBe(409); expect((await list()).json().data.policyVersion).toBe(0);
  expect((await create()).statusCode).toBe(201);
 });
 it('keeps disabled execution local, invalidates external snapshots, and fails closed on policy lookup errors', async () => {
  const local = await grant(); await approved(); const connected = await grant(), renewOnly = await grant(); config.WEBGL_EXTERNAL_CONNECTIONS_ENABLED = false;
  expect((await renew(renewOnly)).statusCode).toBe(403);
  expect((await gate(connected)).statusCode).toBe(403); expect((await renew(connected)).statusCode).toBe(403); expect((await gate(local)).statusCode).toBe(204); expect((await renew(local)).statusCode).toBe(200);
  expect((await list()).statusCode).toBe(404); const disabled = await grant(); expect((await gate(disabled)).headers['x-pcu-runtime-csp']).not.toContain(external);
  config.WEBGL_EXTERNAL_CONNECTIONS_ENABLED = true;
  expect((await gate(renewOnly)).statusCode).toBe(403);
  expect((await renew(renewOnly)).statusCode).toBe(403);
  expect((await gate(connected)).statusCode).toBe(403);
  expect((await renew(connected)).statusCode).toBe(403);
  const fresh = await grant();
  const fail = vi.spyOn(playRepository, 'policyValid').mockRejectedValueOnce(new Error('Policy lookup unavailable'));
  try { expect((await gate(fresh)).statusCode).toBe(500); } finally { fail.mockRestore(); }
 });
 it('takes an atomic snapshot when approval or revocation races session issuance', async () => {
  const id = (await create()).json().data.id;
  const [created, approval] = await Promise.all([issue(), review(id, 'approve')]); expect(created.statusCode).toBe(200); expect(approval.statusCode).toBe(200);
  const snapshot = await db.webglPlaySession.findUniqueOrThrow({ where: { id: created.json().data.id } });
  expect([{ policyVersion: 0, approvedOrigins: [] }, { policyVersion: 1, approvedOrigins: [external] }]).toContainEqual({ policyVersion: snapshot.policyVersion, approvedOrigins: snapshot.approvedOrigins });
  expect((await gate(created.json().data)).statusCode).toBe(204);
  const [raced, revocation] = await Promise.all([issue(), review(id, 'revoke')]); expect(raced.statusCode).toBe(200); expect(revocation.statusCode).toBe(200);
  const revokedSnapshot = await db.webglPlaySession.findUniqueOrThrow({ where: { id: raced.json().data.id } });
  expect([{ policyVersion: 1, approvedOrigins: [external] }, { policyVersion: 2, approvedOrigins: [] }]).toContainEqual({ policyVersion: revokedSnapshot.policyVersion, approvedOrigins: revokedSnapshot.approvedOrigins });
  expect((await gate(raced.json().data)).statusCode).toBe(revokedSnapshot.approvedOrigins.length ? 403 : 204);
 });

 it('keeps another project local and permits operator review', async () => {
  const pending = (await create('wss://*.example.com')).json().data;
  expect((await review(pending.id, 'approve', operatorSid)).statusCode).toBe(200);
  const source = await db.project.create({ data: { creatorId: owner, exhibitionId, title: 'Separate game', slug: randomUUID(), status: 'PUBLISHED' } });
  const asset = await db.asset.create({ data: { projectId: source.id, kind: 'WEBGL', representations: { create: { bucket: 'protected', objectKey: `${randomUUID()}.zip`, role: 'WEBGL_SOURCE', state: 'READY', mimeType: 'application/zip' } } }, include: { representations: true } });
  const id = randomUUID(), prefix = `public/webgl/${source.id}/${id}/`;
  await db.webglDeployment.create({ data: { id, projectId: source.id, sourceRepresentationId: asset.representations[0]!.id, publicBucket: 'public', publicPrefix: prefix, entryObjectKey: prefix + 'index.html', state: 'READY', objectManifest: { version: 1, objects: [{ objectKey: prefix + 'index.html', sizeBytes: '0', mimeType: 'text/html', contentEncoding: null, etag: 'fixture', checksumSha256: null }] } } });
  await db.project.update({ where: { id: source.id }, data: { currentWebglDeploymentId: id } });
  const issued = await request('POST', '/api/webgl-play/sessions', sid, { projectId: source.id }, apiOrigin);
  // The shell's fetch metadata is mandatory even with an otherwise valid session cookie.
  expect(issued.statusCode).toBe(403);
  const grant = await app.inject({ method: 'POST', url: '/api/webgl-play/sessions', headers: { origin: apiOrigin, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', cookie: `sid=${sid}` }, payload: { projectId: source.id } });
  expect(grant.statusCode).toBe(200);
  expect(String((await gate(grant.json().data)).headers['x-pcu-runtime-csp'])).not.toContain('*.example.com');
 });
 it('approves wildcard rules without port expansion and rejects overlaps', async () => {
  expect((await create('wss://*.fixture.example')).statusCode).toBe(400);
  expect((await create('wss://*.github.io')).statusCode).toBe(400);
  await approved('wss://*.example.com:8443');
  const overlap = (await create('wss://a.example.com:8443')).json().data.id;
  expect((await review(overlap, 'approve')).statusCode).toBe(409);
  await approved('wss://example.com:8443');
  const session = await grant();
  const csp = String((await gate(session)).headers['x-pcu-runtime-csp']);
  expect(csp).toContain('wss://*.example.com:8443');
  expect(csp).not.toContain('19090');
 });
 it('serializes concurrent report budgets and rejects revoked snapshots after reapproval', async () => {
  const approvedId = await approved();
  const session = (await issue(true)).json().data as Grant;
  const csp = String((await gate(session)).headers['x-pcu-runtime-csp']);
  const url = new URL(csp.split('report-uri ')[1]!).pathname;
  const report = () => app.inject({ method: 'POST', url, headers: { 'content-type': 'application/csp-report' },
   payload: JSON.stringify({ 'csp-report': { 'blocked-uri': 'https://blocked.example.com/private', 'effective-directive': 'connect-src' } }) });
  const results = await Promise.all(Array.from({ length: 40 }, report));
  expect(results.filter(result => result.statusCode === 204)).toHaveLength(30);
  expect(results.filter(result => result.statusCode === 429)).toHaveLength(10);
  expect(await db.webglPlaySession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ reportCount: 30 });
  expect(await db.webglConnectionDiagnostic.findMany({ where: { sessionId: session.id } })).toMatchObject([{ count: 30 }]);
  await db.webglPlaySession.update({ where: { id: session.id }, data: { reportWindowAt: new Date(0) } });
  expect((await review(approvedId, 'revoke')).statusCode).toBe(200);
  await approved();
  expect((await report()).statusCode).toBe(403);
  const read = await app.inject({ method: 'POST', url: `/api/webgl-play/sessions/${session.id}/diagnostics`, headers: {
   origin: apiOrigin, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', cookie: `sid=${sid}`, 'x-pcu-play-control': session.controlSecret,
  }, payload: {} });
  expect(read.statusCode).toBe(403);
  expect(await db.webglPlaySession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ reportCount: 30 });
 });
 it('isolates diagnostic tokens, strips secrets, limits reports and cascades cleanup', async () => {
  const session = (await issue(true)).json().data as Grant;
  const csp = String((await gate(session)).headers['x-pcu-runtime-csp']);
  const reportUrl = new URL(csp.split('report-uri ')[1]!).pathname;
  const report = (url = reportUrl, origin = 'https://user:password@blocked.example.com/private?token=secret') => app.inject({ method: 'POST', url, headers: { 'content-type': 'application/csp-report' }, payload: JSON.stringify({ 'csp-report': { 'blocked-uri': origin, 'effective-directive': 'connect-src', 'document-uri': 'https://secret.invalid/path', 'script-sample': 'secret-code' } }) });
  const read = (id = session.id, controlSecret = session.controlSecret) => app.inject({ method: 'POST', url: `/api/webgl-play/sessions/${id}/diagnostics`, headers: { origin: apiOrigin, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', cookie: `sid=${sid}`, 'x-pcu-play-control': controlSecret }, payload: {} });
  expect((await read()).json().data.items).toEqual([]);
  logs = '';
  const malformed = await app.inject({ method: 'POST', url: reportUrl, headers: { 'content-type': 'application/json' }, payload: '{"private-report-credential":' });
  expect(malformed.statusCode).toBe(400);
  expect(malformed.body).not.toContain('private-report-credential');
  expect((await Promise.all([report(), report()])).map(result => result.statusCode)).toEqual([204, 204]);
  const data = (await read()).json().data;
  expect(data).toMatchObject({ gameOrigin, policyVersion: 0, approvedOrigins: [], items: [{ origin: 'https://blocked.example.com', directive: 'connect-src', count: 2 }] });
  expect(JSON.stringify(data)).not.toMatch(/password|private|secret-code|token=/);
  expect((await report('/api/webgl-play/reports/' + 'f'.repeat(64))).statusCode).toBe(403);
  expect((await report('/api/webgl-play/reports/' + session.controlSecret)).statusCode).toBe(403);
  expect((await request('POST', `/api/webgl-play/sessions/${session.id}/diagnostics`, sid, {}, gameOrigin)).statusCode).toBe(403);
  const other = (await issue(true)).json().data as Grant;
  expect((await read(other.id)).statusCode).toBe(403);
  expect((await read(session.id, 'f'.repeat(64))).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url: reportUrl, headers: { 'content-type': 'application/csp-report' }, payload: 'x'.repeat(16385) })).statusCode).toBe(413);
  for (let i = 0; i < 28; i++) expect((await report(reportUrl, `https://blocked${i}.example.com/path`)).statusCode).toBe(204);
  expect((await read()).json().data.items).toHaveLength(20);
  expect((await report()).statusCode).toBe(429);
  await db.webglPlaySession.update({ where: { id: session.id }, data: { reportWindowAt: new Date(Date.now() - 61000) } });
  expect((await report()).statusCode).toBe(204);
  expect(logs).not.toContain(reportUrl.split('/').at(-1));
  expect(logs).not.toMatch(/password|secret-code|private-report-credential/);
  await db.webglPlaySession.update({ where: { id: session.id }, data: { expiresAt: new Date(0) } });
  expect((await report()).statusCode).toBe(403);
  expect((await read()).statusCode).toBe(403);
  await grant();
  expect(await db.webglConnectionDiagnostic.count({ where: { sessionId: session.id } })).toBe(0);
 });

});
