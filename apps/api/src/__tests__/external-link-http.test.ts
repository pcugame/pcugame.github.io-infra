import Fastify, { type FastifyInstance, type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createProjectChangeController } from '../modules/project-change/controller.js';
import { createProjectChangeService } from '../modules/project-change/service.js';
import type { ProjectChangeRepository } from '../modules/project-change/ports.js';
import { ProjectChangeDetailSchema } from '@pcu/contracts';
import type { ExternalLink } from '@pcu/contracts';
import type { AppLogger } from '../application/ports.js';
import type { Env } from '../config/env.js';
import { registerAuth } from '../plugins/auth.js';
import { registerCsrf } from '../plugins/csrf.js';
import { registerRouteSchemas } from '../shared/http-route-schemas.js';
import { createExternalLinkController } from '../modules/external-links/controller.js';
import { createExternalLinkService } from '../modules/external-links/service.js';
import type { ResolveExternalLink } from '../modules/external-links/resolver.js';
import { enrichExternalLinks } from '../modules/external-links/resolver.js';
import { createProjectController } from '../modules/admin/project/controller.js';
import { createProjectService } from '../modules/admin/project/service.js';
import { createProjectSerializer } from '../modules/admin/project/serializer.js';
import { createSubmitProjectService } from '../modules/admin/project/project-submit.service.js';
import { createMeProjectController } from '../modules/me/project/controller.js';
import { createAdminProjectMetadataController } from '../modules/admin/project/metadata.controller.js';
import type { ProjectSubmissionRecord, SubmitProjectRepository, ProjectCrudRepository } from '../modules/admin/project/ports.js';
import { defaultTestEnv } from './helpers/app-mocks.js';

const logger: AppLogger = { child: () => logger, trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() };
const origin = 'http://localhost:5173';
const actor = { id: 7, googleSub: 'owner', email: 'owner@g.pcu.ac.kr', name: 'Owner', role: 'USER' as const, studentId: '20260001' };
const admin = { ...actor, id: 8, role: 'ADMIN' as const };
const headers = { origin, cookie: 'sid=owner' };
const linkInput: ExternalLink[] = [{ label: 'Video', url: 'https://short.example/video', service: 'github' }, { label: 'Source', url: 'https://github.com/pcu/game', service: 'discord' }, { label: 'Other', url: 'http://127.0.0.1/', service: 'youtube' }];
const expectedLinks = [{ label: 'Video', url: 'https://short.example/video', service: 'youtube' }, { label: 'Source', url: 'https://github.com/pcu/game', service: 'github' }, { label: 'Other', url: 'http://127.0.0.1/' }];
let app: FastifyInstance;
let resolve: Mock<ResolveExternalLink>;
let savedLinks: ExternalLink[] | undefined;
let create: Mock<SubmitProjectRepository['createProjectWithAssets']>;
let update: Mock<ProjectCrudRepository['updateProject']>;
let time: number;
beforeEach(async () => {
 time = Date.now(); savedLinks = undefined;
 resolve = vi.fn(async (url: string) => url === 'https://short.example/video' ? 'youtube' as const : null);
 const resolveLinks: typeof enrichExternalLinks = (links) => enrichExternalLinks(links, resolve);
 app = Fastify(); app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
 app.setErrorHandler<FastifyError & { details?: { retryAfterSec?: number } }>((error, _request, reply) => {
  if ('details' in error && typeof error.details === 'object' && error.details && 'retryAfterSec' in error.details) reply.header('Retry-After', String(error.details.retryAfterSec));
  reply.status(error.validation ? 400 : error.statusCode ?? 500).send({ ok: false, error: { code: error.validation ? 'VALIDATION_ERROR' : error.code ?? 'ERROR', message: error.message } });
 });
 await app.register(cookie); await app.register(multipart);
 await registerAuth(app, { config: { ...defaultTestEnv, COOKIE_SAME_SITE: 'lax' }, clock: { now: () => new Date(time) }, logger,
  sessions: { find: async (id) => ['owner', 'admin'].includes(id) ? { id, expiresAt: new Date(time + 3600000), lastSeenAt: new Date(time), user: id === 'owner' ? actor : admin } : null, touch: vi.fn(), delete: vi.fn() } });
 await registerCsrf(app, defaultTestEnv as unknown as Env); registerRouteSchemas(app);
 await app.register(createExternalLinkController(createExternalLinkService(resolve, () => time)), { prefix: '/api/me' });
 const project = { id: 1, visibility: 'PUBLIC' as const, creatorId: 7, title: 'Game', slug: 'game', summary: '', description: '', githubUrl: '', platforms: [], isIncomplete: false, status: 'DRAFT' as const, sortOrder: 0, posterAssetId: null, poster: null, members: [], assets: [], exhibition: { visibility: 'PUBLIC' as const, year: 2026 } };
 update = vi.fn(async (_id, patch) => { if (patch.externalLinks !== undefined) savedLinks = patch.externalLinks; return { ...project, externalLinks: savedLinks }; });
 const service = createProjectService({ repository: { findProjectsForUser: vi.fn(), findProjectById: vi.fn(), isMemberOfProject: vi.fn(), updateProject: update, deleteProjectReturningAssets: vi.fn(), clearWebglDeployment: vi.fn(), findAssetById: vi.fn(), setProjectVideoOrder: vi.fn(), setProjectPoster: vi.fn(), bulkDeleteProjectsReturningAssets: vi.fn() }, serializeProjectDetail: createProjectSerializer('http://localhost:4000').serializeProjectDetail, resolveExternalLinks: resolveLinks, deletionBuckets: { publicBucket: 'public', protectedBucket: 'protected' }, abortMultipart: vi.fn(), wakeDeletionWorker: vi.fn(), wakeMaintenance: vi.fn(), logger });
 await app.register(createProjectController({ service, access: { loadProjectWithAccess: vi.fn(async () => project) }, status: { assertTransition: vi.fn(), bulkUpdate: vi.fn() } }), { prefix: '/api/admin' });
 const submission: ProjectSubmissionRecord = { id: '11111111-1111-4111-8111-111111111111', projectId: 1, actorId: 7, state: 'PENDING', project: { id: 1, status: 'DRAFT' }, items: [], publicationJob: null };
 create = vi.fn(async (data) => { savedLinks = data.externalLinks; return { id: 1, slug: 'game', submission }; });
 const repository: SubmitProjectRepository = { findExhibitionById: vi.fn(async () => ({ id: 1, year: 2026, title: '2026', visibility: 'PUBLIC' as const, isModificationEnabled: true })), findProjectByExhibitionAndSlug: vi.fn(async () => null), createProjectWithAssets: create, findSubmissionForActor: vi.fn(), finalizeSubmission: vi.fn(), cancelSubmission: vi.fn(), auditActiveSubmissions: vi.fn() };
 const submit = createSubmitProjectService({ webPublicUrl: 'http://localhost:5173', repository, resolveExternalLinks: resolveLinks });
 await app.register(createMeProjectController({ service: submit, route: { rateLimit: { max: 30, timeWindow: 60000 } } }), { prefix: '/api/me' });
 await app.register(createAdminProjectMetadataController({ service: submit, route: { rateLimit: { max: 30, timeWindow: 60000 } } }), { prefix: '/api/admin' });
 const detail = ProjectChangeDetailSchema.parse({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', projectId: 1, originalProjectId: 1, projectTitle: 'Game', actorId: 7, kind: 'EDIT', state: 'DRAFT', reason: 'Update links', reviewReason: null, reviewerId: null, error: null, baseVersion: 1, createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z', submittedAt: null, reviewedAt: null, completedAt: null, before: { assets: [], currentWebglDeploymentId: null }, changes: {}, stagingProjectId: null, submissionId: null, items: [], stagedAssets: [] });
 const changes: ProjectChangeRepository = { list: vi.fn(), detail: vi.fn(async () => detail), create: vi.fn(), update: vi.fn(async (_actor, _id, input) => { savedLinks = input.changes?.externalLinks; return { ...detail, changes: input.changes ?? {} }; }), transition: vi.fn() };
 await app.register(createProjectChangeController(createProjectChangeService(changes, resolveLinks), 'me'), { prefix: '/api/me' });
 await app.ready();
});
afterEach(async () => { await app.close(); });
function request(payload: unknown, requestHeaders: Record<string, string> = headers, url = '/api/me/external-links/resolve') { return app.inject({ method: 'POST', url, headers: requestHeaders, payload: payload as Record<string, unknown> }); }

describe('authenticated external link HTTP boundary', () => {
 it('returns the success envelope for authenticated resolution', async () => { const response = await request({ url: 'https://short.example/video' }); expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ ok: true, data: { service: 'youtube' } }); expect(response.headers['cache-control']).toBe('private, no-store'); });
 it('requires session and trusted origin before outbound work', async () => {
  for (const [requestHeaders, expected] of [[{ origin }, 401], [{ origin, cookie: 'sid=bad' }, 401], [{ cookie: 'sid=owner' }, 403], [{ origin: 'https://evil.example', cookie: 'sid=owner' }, 403]] as const) { expect((await request({ url: 'https://short.example/video' }, requestHeaders)).statusCode).toBe(expected); }
  expect(resolve).not.toHaveBeenCalled();
 });
 it.each([{}, { url: 'javascript:alert(1)' }, { url: 'not a url' }, { url: 'https://github.com', service: 'youtube' }])('rejects malformed or extra fields %j', async (payload) => { expect((await request(payload)).statusCode).toBe(400); expect(resolve).not.toHaveBeenCalled(); });
 it('returns null for generic URLs and rejects unknown query fields', async () => { expect((await request({ url: 'https://generic.example/' })).json()).toEqual({ ok: true, data: { service: null } }); expect((await request({ url: 'https://generic.example/' }, headers, '/api/me/external-links/resolve?extra=1')).statusCode).toBe(400); });
 it('limits attempts per user across URLs and cache hits', async () => {
  for (let index = 0; index < 30; index++) expect((await request({ url: 'https://short.example/video' })).statusCode).toBe(200);
  const rejected = await request({ url: 'https://other.example/' }); expect(rejected.statusCode).toBe(429); expect(rejected.headers['retry-after']).toBe('60');
  expect((await request({ url: 'https://short.example/video' }, { origin, cookie: 'sid=admin' })).statusCode).toBe(200); expect(resolve).toHaveBeenCalledTimes(2);
  time += 60000; expect((await request({ url: 'https://short.example/video' })).statusCode).toBe(200);
 });
});
describe('server-derived links through authenticated saves', () => {
 it('patches services, preserves user text and omitted values, and supports removal', async () => {
  const response = await app.inject({ method: 'PATCH', url: '/api/admin/projects/1', headers, payload: { externalLinks: linkInput } }); expect(response.statusCode, response.body).toBe(200); expect(savedLinks).toEqual(expectedLinks); expect(response.json().data.externalLinks).toEqual(expectedLinks);
  const omitted = await app.inject({ method: 'PATCH', url: '/api/admin/projects/1', headers, payload: { summary: 'Updated' } }); expect(omitted.statusCode).toBe(200); expect(savedLinks).toEqual(expectedLinks); expect(update.mock.calls[1]?.[1]).not.toHaveProperty('externalLinks');
  const removed = await app.inject({ method: 'PATCH', url: '/api/admin/projects/1', headers, payload: { externalLinks: [] } }); expect(removed.statusCode).toBe(200); expect(savedLinks).toEqual([]);
 });
 it('derives draft change services and rejects a nonauthor before resolution', async () => {
  const url = '/api/me/change-requests/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const forbidden = await app.inject({ method: 'PATCH', url, headers: { origin, cookie: 'sid=admin' }, payload: { changes: { externalLinks: linkInput } } });
  expect(forbidden.statusCode).toBe(403); expect(resolve).not.toHaveBeenCalled();
  const response = await app.inject({ method: 'PATCH', url, headers, payload: { changes: { externalLinks: linkInput } } });
  expect(response.statusCode, response.body).toBe(200); expect(savedLinks).toEqual(expectedLinks); expect(response.json().data.changes.externalLinks).toEqual(expectedLinks);
 });
 it.each([['me', 'owner'], ['admin', 'admin']])('derives services for multipart %s submission', async (audience, session) => {
  const boundary = 'external-links-save'; const payload = { exhibitionId: 1, title: 'Game', members: [{ name: 'Owner', studentId: '20260001' }], manifest: [], externalLinks: linkInput };
  const response = await app.inject({ method: 'POST', url: `/api/${audience}/projects/submit`, headers: { origin, cookie: `sid=${session}`, 'idempotency-key': 'external-links-submission', 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: `--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\n\r\n${JSON.stringify(payload)}\r\n--${boundary}--\r\n` }); expect(response.statusCode, response.body).toBe(201); expect(savedLinks).toEqual(expectedLinks); expect(create).toHaveBeenCalledOnce();
 });
});
