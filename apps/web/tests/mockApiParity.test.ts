/** Isolated HTTP comparisons: real auth/controller/service/serializer, scripted persistence only. */
import { createRequire } from 'node:module';
import Fastify, { type FastifyInstance, type FastifyPluginCallback } from 'fastify';
const apiRequire = createRequire(new URL('../../api/package.json', import.meta.url));
const cookie = apiRequire('@fastify/cookie') as FastifyPluginCallback;
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod';
import { AdminProjectDetailSchema, ProjectChangeDetailSchema, type ProjectChangeDetail } from '@pcu/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAuthService } from '../../api/src/modules/auth/service';
import { createDevAuthController } from '../../api/src/modules/dev-auth/controller';
import { registerAuth } from '../../api/src/plugins/auth';
import { registerRouteSchemas } from '../../api/src/shared/http-route-schemas';
import { AppError } from '../../api/src/shared/errors';
import { createProjectController } from '../../api/src/modules/admin/project/controller';
import { createProjectService } from '../../api/src/modules/admin/project/service';
import { createProjectSerializer } from '../../api/src/modules/admin/project/serializer';
import { createProjectAccessService } from '../../api/src/modules/admin/project-access.service';
import type { ProjectCrudRepository, ProjectDetailRecord } from '../../api/src/modules/admin/project/ports';
import { createWebglNetworkController } from '../../api/src/modules/webgl-network/controller';
import { createWebglNetworkService } from '../../api/src/modules/webgl-network/service';
import { createWebglNetworkRepository } from '../../api/src/modules/webgl-network/repository';
import type { PrismaClient } from '../../api/src/generated/prisma/client';
import { defaultTestEnv } from '../../api/src/__tests__/helpers/app-mocks';
import { createProjectChangeController } from '../../api/src/modules/project-change/controller';
import { createProjectChangeService } from '../../api/src/modules/project-change/service';
import type { ProjectChangeRepository } from '../../api/src/modules/project-change/ports';
import { mockFetch, resetMockState, selectMockUser, updateMockState } from '../src/lib/api/mock/transport';
import { createMockContext } from '../src/lib/api/mock/context';
import { projectCapabilities } from '../src/lib/api/mock/policy';

const origin = 'http://localhost:5173';
const now = new Date('2026-10-06T00:00:00.000Z');
const clock = { now: () => now };
const config = { SESSION_COOKIE_NAME: 'sid', SESSION_IDLE_MS: 3600000, SESSION_TOUCH_MIN_INTERVAL_MS: 3600000,
  COOKIE_SECURE: false, COOKIE_SAME_SITE: 'lax' as const, CORS_ALLOWED_ORIGINS: [origin] };
let app: FastifyInstance;
let record: ProjectDetailRecord;
let studentCookie: string;

beforeEach(async () => {
  await resetMockState(); await selectMockUser('owner');
  record = { id: 1, creatorId: 3, title: 'Before', slug: 'parity', visibility: 'PUBLIC', summary: '', description: '', githubUrl: '',
    exhibition: { year: 2025, visibility: 'PUBLIC', isModificationEnabled: true }, platforms: ['PC'], isIncomplete: true,
    status: 'PUBLISHED', sortOrder: 0, posterAssetId: null, poster: null,
    members: [{ id: 101, name: '학생', studentId: '2088099', sortOrder: 0, userId: 3 }, { id: 102, name: '참여 학생', studentId: '2088100', sortOrder: 1, userId: 4 }], assets: [] };
  app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
  await app.register(cookie);
  const users = new Map<number, { id:number; googleSub:string; email:string; name:string; role:'USER'|'ADMIN'|'OPERATOR'; studentId:string|null }>();
  const sessions = new Map<string, { id:string; expiresAt:Date; lastSeenAt:Date; user: NonNullable<ReturnType<typeof users.get>> }>();
  let next = 0;
  const auth = createAuthService({
    repository: {
      upsertUserByGoogleSub: async () => { throw new Error('Google is outside this fixture'); },
      upsertDevUser: async data => { const user = { ...data, id: data.role === 'USER' ? 3 : data.role === 'ADMIN' ? 1 : 2, studentId: data.studentId ?? null }; users.set(user.id, user); return user; },
      createSession: async data => { const session = { ...data, lastSeenAt: now, user: users.get(data.userId)! }; sessions.set(data.id, session); return session; },
      delete: async id => sessions.delete(id),
    }, googleTokens: { verify: async () => undefined }, clock, ids: { next: () => `session-${++next}` },
    sessionAbsoluteMs: 3600000, googleClientIds: [], allowedGoogleHostedDomain: '', logger: app.log,
  });
  await registerAuth(app, { config, clock, logger: app.log, sessions: {
    find: async id => sessions.get(id) ?? null, touch: async () => {}, delete: async id => { sessions.delete(id); },
  } });
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof AppError ? error.statusCode : 500;
    reply.status(status).send({ ok: false, error: { code: error instanceof AppError ? error.code : 'INTERNAL_ERROR', message: error instanceof Error ? error.message : 'Internal error' } });
  });
  const repository = {
    findProjectById: async () => record,
    updateProject: async (_id: number, patch: Partial<ProjectDetailRecord>) => { Object.assign(record, patch); return record; },
  } as unknown as ProjectCrudRepository;
  const service = createProjectService({ repository,
    serializeProjectDetail: createProjectSerializer('http://localhost:4000', { publicAssetOrigin: 'https://assets.example.test', publicBucket: 'public' }).serializeProjectDetail,
    deletionBuckets: { publicBucket:'public', protectedBucket:'protected' }, abortMultipart: async () => {}, wakeDeletionWorker() {}, wakeMaintenance() {}, logger: app.log,
  });
  const access = createProjectAccessService({
    findProject: async () => ({ id:1, exhibitionId:1, creatorId:3, status:record.status, isModificationEnabled:record.exhibition.isModificationEnabled }),
    isLinkedMember: async (_id, actor) => record.members.some(member => member.userId === actor),
  });
  registerRouteSchemas(app);
  await app.register(createDevAuthController({ config, clock, service:auth }), { prefix:'/api/dev' });
  await app.register(createProjectController({ service, access, status: { assertTransition() {}, bulkUpdate:async () => ({updated:0}) } }), { prefix:'/api/admin' });
  const networkPersistence = {
    $transaction: async (operation: (tx: unknown) => unknown) => operation({
      project: { findUnique: async () => ({...record, changeRequestDraft:null, webglNetworkPolicyVersion:1}) },
      webglNetworkRequest: { findMany: async () => [] },
    }),
  } as unknown as PrismaClient;
  const network = createWebglNetworkService(createWebglNetworkRepository(networkPersistence), {
    ...defaultTestEnv, WEBGL_EXTERNAL_CONNECTIONS_ENABLED:true, PUBLIC_ASSET_ORIGIN:origin,
  });
  await app.register(createWebglNetworkController(network,'me'), {prefix:'/api/me'});
  await app.register(createWebglNetworkController(network,'admin'), {prefix:'/api/admin'});
  const changePersistence = { list:async () => ({items:[],total:0}),
    create:async (_actor:unknown,_project:number,input:{kind:'EDIT'|'DELETE';reason:string}):Promise<ProjectChangeDetail> => ({
      id:'12345678-1234-4234-8234-123456789abc',projectId:1,originalProjectId:1,projectTitle:'Before',actorId:3,
      kind:input.kind,state:'DRAFT',reason:input.reason,reviewReason:null,reviewerId:null,error:null,baseVersion:1,
      createdAt:now.toISOString(),updatedAt:now.toISOString(),submittedAt:null,reviewedAt:null,completedAt:null,
      before:{title:'Before',assets:[],currentWebglDeploymentId:null},changes:{},stagingProjectId:null,submissionId:null,items:[],stagedAssets:[],
    }),
  } as unknown as ProjectChangeRepository;
  const changes = createProjectChangeService(changePersistence);
  await app.register(createProjectChangeController(changes,'me'),{prefix:'/api/me'});
  await app.register(createProjectChangeController(changes,'admin'),{prefix:'/api/admin'});
  await app.ready();
  const login = await app.inject({ method:'POST', url:'/api/dev/auth/login', headers:{origin}, payload:{role:'USER'} });
  expect(login.statusCode, login.body).toBe(200);
  studentCookie = login.cookies[0]!.name + '=' + login.cookies[0]!.value;
  await updateMockState(state => { const project = state.projects[1]; Object.assign(project, {
    title:'Before',slug:'parity',summary:undefined,description:undefined,githubUrl:undefined,isIncomplete:true,platforms:['PC'],
    assets:[],attachments:[],videos:[],video:null,poster:undefined,posterAssetId:undefined,webglUrl:undefined,webglDeployment:undefined,members:record.members,
  }); });
});
afterEach(async () => { await app.close(); });

function actual(method:'GET'|'PATCH', payload?:unknown) {
  return app.inject({ method, url:'/api/admin/projects/1', headers:{origin,cookie:studentCookie}, ...(payload ? {payload} : {}) });
}
async function mocked(method:'GET'|'PATCH', body?:unknown) {
  return mockFetch('/api/admin/projects/1', {method,body});
}
const capabilities = ['canEdit','canDelete','canChangeVisibility','canRequestChange','canEditWebglDisplay','isModificationEnabled'] as const;

describe('authenticated real API and mock response parity', () => {
  it('uses a real dev-login cookie for a successful student PATCH and serialized read', async () => {
    const mockLogin = await mockFetch('/api/dev/auth/login', {method:'POST',body:{role:'USER'}});
    expect(mockLogin.status).toBe(200); expect((await mockLogin.json()).data.user).toMatchObject({id:3,role:'USER'});
    const response = await actual('PATCH', {title:'After'});
    const mock = await mocked('PATCH', {title:'After'});
    expect(response.statusCode, response.body).toBe(200); expect(mock.status).toBe(200);
    const actualDetail = AdminProjectDetailSchema.parse(response.json().data);
    const mockDetail = AdminProjectDetailSchema.parse((await mock.json()).data);
    expect(mockDetail.title).toBe(actualDetail.title);
    for (const key of capabilities) expect(mockDetail[key]).toBe(actualDetail[key]);
    const read = await actual('GET'); expect(AdminProjectDetailSchema.parse(read.json().data).title).toBe('After');
  });
  it.each([false,true])('serializes actual read/PATCH collections with populated materials=%s', async populated => {
    if (populated) {
      record.assets = [{id:192,kind:'DOCUMENT',originalName:'readme.txt',representations:[{role:'ORIGINAL',bucket:'protected',objectKey:'readme',mimeType:'text/plain',state:'READY',sizeBytes:64n}]}];
      await updateMockState(state => { state.projects[1].attachments = [{assetId:192,kind:'DOCUMENT',originalName:'readme.txt',sizeBytes:64,mimeType:'text/plain',downloadUrl:'http://localhost:5173/mock/files/readme.txt'}]; state.projects[1].assets = [{id:192,kind:'DOCUMENT',originalName:'readme.txt',size:64,mimeType:'text/plain',downloadUrl:'http://localhost:5173/mock/files/readme.txt'}]; });
    }
    for (const method of ['GET','PATCH'] as const) {
      const response = await actual(method, method === 'PATCH' ? {title:'Collections'} : undefined);
      const mock = await mocked(method, method === 'PATCH' ? {title:'Collections'} : undefined);
      expect(response.statusCode, response.body).toBe(200); expect(mock.status).toBe(200);
      const real = AdminProjectDetailSchema.parse(response.json().data), local = AdminProjectDetailSchema.parse((await mock.json()).data);
      expect(local.assets.length).toBe(real.assets.length);
      expect(local.attachments?.length ?? 0).toBe(real.attachments?.length ?? 0);
      expect(local.videos).toEqual(real.videos);
    }
  });
  it('matches authenticated network-list success and unrelated/student-review denials', async () => {
    const url='/api/me/projects/1/webgl-network-requests';
    const response = await app.inject({method:'GET',url,headers:{origin,cookie:studentCookie}});
    const local = await mockFetch(url);
    expect(response.statusCode,response.body).toBe(200); expect(local.status).toBe(200);
    expect((await local.json()).data.items).toEqual(response.json().data.items);
    const admin='/api/admin/webgl-network-requests';
    expect((await app.inject({method:'GET',url:admin,headers:{origin,cookie:studentCookie}})).statusCode).toBe(403);
    expect((await mockFetch(admin)).status).toBe(403);
    record.creatorId=5; record.members=[];
    await updateMockState(state=>{state.projects[1].createdByUserId=5;state.projects[1].members=[];});
    expect((await app.inject({method:'GET',url,headers:{origin,cookie:studentCookie}})).statusCode).toBe(403);
    expect((await mockFetch(url)).status).toBe(403);
  });
  it('matches authenticated change-list serialization and student review denial', async () => {
    const url='/api/me/change-requests';
    const response=await app.inject({method:'GET',url,headers:{origin,cookie:studentCookie}});
    const local=await mockFetch(url);
    expect(response.statusCode,response.body).toBe(200);expect(local.status).toBe(200);
    expect((await local.json()).data).toEqual(response.json().data);
    const review='/api/admin/change-requests';
    expect((await app.inject({method:'GET',url:review,headers:{origin,cookie:studentCookie}})).statusCode).toBe(403);
    expect((await mockFetch(review)).status).toBe(403);
  });
  it('matches real HTTP Created and serialized draft data for change-request creation', async () => {
    await updateMockState(state=>{state.exhibitions.find(item=>item.id===1)!.isModificationEnabled=false;});
    const url='/api/me/projects/1/change-requests', input={kind:'EDIT',reason:'Update the project description'};
    const response=await app.inject({method:'POST',url,headers:{origin,cookie:studentCookie},payload:input});
    const local=await mockFetch(url,{method:'POST',body:input});
    expect(response.statusCode,response.body).toBe(201);expect(local.status).toBe(response.statusCode);
    const real=ProjectChangeDetailSchema.parse(response.json().data), mocked=ProjectChangeDetailSchema.parse((await local.json()).data);
    expect(mocked).toMatchObject({actorId:real.actorId,projectId:real.projectId,kind:real.kind,state:real.state,reason:real.reason});
  });
  it('matches closed-exhibition student write denial and change-request capability', async () => {
    record.exhibition.isModificationEnabled = false;
    const snapshot = await updateMockState(state => { state.exhibitions.find(item=>item.id===1)!.isModificationEnabled=false; });
    const read = await actual('GET'); const localRead = await mocked('GET');
    const real = read.json().data, local = (await localRead.json()).data;
    expect(real.canRequestChange).toBe(true); expect(local.canRequestChange).toBe(true);
    for (const key of capabilities) expect(local[key]).toBe(real[key]);
    const response = await actual('PATCH', {title:'Forbidden'}), mock = await mocked('PATCH', {title:'Forbidden'});
    expect(response.statusCode).toBe(403); expect(mock.status).toBe(403);
    expect((await mock.json()).error.code).toBe(response.json().error.code);
    expect(projectCapabilities(createMockContext(snapshot),snapshot.projects[1]).canRequestChange).toBe(true);
  });
});
