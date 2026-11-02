import { registerCsrf } from '../plugins/csrf.js';
import { parseEnv } from '../config/env.js';
import { defaultTestEnv } from './helpers/app-mocks.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createIsolatedMigratedDatabase } from './helpers/isolated-migrated-database.js';
import { registerAuth } from '../plugins/auth.js';
import { AppError } from '../shared/errors.js';
import { registerRouteSchemas } from '../shared/http-route-schemas.js';
import { createAwardGraph } from '../modules/awards/composition.js';
import { createAwardRepository } from '../modules/awards/repository.js';
import { createAwardService } from '../modules/awards/service.js';
import { createProjectCrudRepository } from '../modules/admin/project/crud.repository.js';
import { createProjectService } from '../modules/admin/project/service.js';
import { createProjectSerializer } from '../modules/admin/project/serializer.js';
import { createProjectController } from '../modules/admin/project/controller.js';
import { createProjectAccessService } from '../modules/admin/project-access.service.js';
import { createProjectAccessRepository } from '../modules/admin/project-access.repository.js';
import { assertStatusTransition } from '../modules/admin/project/project-status.service.js';
import { createPublicRepository } from '../modules/public/repository.js';
import { createPublicService } from '../modules/public/service.js';
import { createPublicController } from '../modules/public/controller.js';

const migration = '20261102000000_exhibition_awards';
describe.runIf(process.env['RUN_POSTGRES_INTEGRATION'] === 'true')('awards production repositories and authenticated HTTP', () => {
 let database: Awaited<ReturnType<typeof createIsolatedMigratedDatabase>>, db: PrismaClient, app: FastifyInstance;
 const sessions: Record<string,string> = {}; let creatorId: number;
 beforeAll(async () => {
  database = await createIsolatedMigratedDatabase(process.env['DATABASE_URL']!); db = database.createClient();
  for (const role of ['ADMIN','OPERATOR','USER'] as const) {
   const user = await db.user.create({ data: { role, googleSub:randomUUID(),email:`${randomUUID()}@test.invalid` } }); creatorId=user.id;
   sessions[role] = (await db.authSession.create({ data: { userId:user.id,expiresAt:new Date(Date.now()+3600000) } })).id;
  }
  app=Fastify();app.setValidatorCompiler(validatorCompiler);app.setSerializerCompiler(serializerCompiler);await app.register(cookie);
  await registerAuth(app,{ config:{ SESSION_COOKIE_NAME:'sid',SESSION_IDLE_MS:3600000,SESSION_TOUCH_MIN_INTERVAL_MS:3600000,COOKIE_SECURE:false,COOKIE_SAME_SITE:'lax',CORS_ALLOWED_ORIGINS:['http://localhost:5173'] },clock:{now:()=>new Date()},logger:app.log,sessions:{find:id=>db.authSession.findUnique({where:{id},include:{user:true}}),delete:async id=>{await db.authSession.delete({where:{id}});},touch:async()=>{}} });
  app.setErrorHandler((error,_req,reply)=>{reply.status(error instanceof AppError?error.statusCode:400).send({ok:false,error:{code:error instanceof AppError?error.code:'ERROR',message:error instanceof Error?error.message:'Error'}});});
  await registerCsrf(app, parseEnv({...Object.fromEntries(Object.entries(defaultTestEnv).map(([key,value])=>[key,Array.isArray(value)?value.join(','):String(value)])), LOG_LEVEL:'info'}));
  registerRouteSchemas(app);
  await app.register(createAwardGraph(createAwardRepository(db),'http://assets.test','pcu-public'),{prefix:'/api/admin'});
  const repository=createProjectCrudRepository(db);
  const service=createProjectService({repository,serializeProjectDetail:createProjectSerializer('http://localhost:3000',{publicAssetOrigin:'http://assets.test',publicBucket:'pcu-public'}).serializeProjectDetail,deletionBuckets:{publicBucket:'pcu-public',protectedBucket:'pcu-protected'},abortMultipart:async()=>{},wakeDeletionWorker(){},wakeMaintenance(){},logger:app.log});
  await app.register(createProjectController({service,access:createProjectAccessService(createProjectAccessRepository(db)),status:{assertTransition:assertStatusTransition,bulkUpdate:async(ids,status)=>({updated:(await repository.bulkUpdateStatus(ids,status)).count})}}),{prefix:'/api/admin'});
  await app.register(createPublicController({service:createPublicService({repository:createPublicRepository(db),apiPublicUrl:'http://localhost:3000',publicAssetOrigin:'http://assets.test',publicBucket:'pcu-public'})}),{prefix:'/api/public'});
 },120000);
 afterAll(async()=>{await app?.close();await database?.close();});
 const request=(method:'GET'|'POST'|'PATCH'|'PUT'|'DELETE',url:string,payload?:unknown,role:string|null='ADMIN',origin='http://localhost:5173')=>app.inject({method,url,headers:{origin,...(role?{cookie:`sid=${sessions[role]}`}:{})},...(payload===undefined?{}:{payload:payload as Record<string,unknown>})});
 async function fixture(){const e=await db.exhibition.create({data:{year:2099,title:randomUUID()}});const p=await db.project.create({data:{exhibitionId:e.id,creatorId,title:'Award project',slug:randomUUID(),status:'PUBLISHED',publicationStatus:'PUBLIC',sortOrder:71}});return {e,p,base:`/api/admin/exhibitions/${e.id}/awards`};}
 const service=()=>createAwardService(createAwardRepository(db),'http://assets.test','pcu-public');
 it('enforces roles and CSRF, and serializes empty, single and multiple awards across read/write responses',async()=>{
  const {e,p,base}=await fixture();
  for(const [role,status] of [[null,401],['USER',403]] as const)expect((await request('GET',base,undefined,role)).statusCode).toBe(status);
  const body={expectedVersion:0,name:'Gold',builtinKey:'medal',assetId:null};
  expect((await request('POST',base,body,'ADMIN','https://attacker.invalid')).statusCode).toBe(403);
  const detail=`/api/admin/projects/${p.id}`,pub=`/api/public/projects/${p.id}`;
  for(const path of [detail,pub])expect((await request('GET',path)).json().data.awards).toEqual([]);
  for(const [i,role] of ['ADMIN','OPERATOR'].entries()){
   const result=await request('POST',base,{...body,expectedVersion:i,name:role},role);expect(result.statusCode,result.body).toBe(200);
  }
  const state=(await request('GET',base)).json().data;
  for(const ids of [[state.items[0]!.id],state.items.map((a:{id:number})=>a.id)]){
   const version=(await request('GET',base)).json().data.version;
   const saved=await request('PUT',`${detail}/awards`,{expectedVersion:version,awardIds:ids});expect(saved.statusCode,saved.body).toBe(200);
   for(const path of [detail,pub]){const response=await request('GET',path);expect(response.statusCode,response.body).toBe(200);expect(response.json().data.awards).toHaveLength(ids.length);expect(response.json().data.awards[0]).not.toHaveProperty('projectIds');}
   const savedProject=await request('PATCH',detail,{title:`Saved ${ids.length}`});expect(savedProject.statusCode,savedProject.body).toBe(200);expect(savedProject.json().data.awards).toHaveLength(ids.length);
   const adminList=await request('GET','/api/admin/projects?limit=100');expect(adminList.json().data.items.find((item:{id:number})=>item.id===p.id).awards).toHaveLength(ids.length);
   const publicList=await request('GET',`/api/public/exhibitions/${e.id}/projects`);expect(publicList.statusCode,publicList.body).toBe(200);expect(publicList.json().data.items.find((item:{id:number})=>item.id===p.id).awards).toHaveLength(ids.length);
  }
  const reopened=database.createClient();expect(await reopened.projectAward.count({where:{projectId:p.id}})).toBe(2);
 });
 it('rejects same-version races and rolls back invalid batch changes',async()=>{
  const {e,p}=await fixture();const s=service();const changes=await Promise.allSettled([1,2].map(n=>s.change(e.id,0,{kind:'create',name:`Award ${n}`,builtinKey:'medal',assetId:null})));
  expect(changes.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect((changes.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.statusCode).toBe(409);
  const state=await s.read(e.id);await expect(s.change(e.id,state.version,{kind:'recipients',awardId:state.items[0]!.id,addProjectIds:[p.id,2147483647],removeProjectIds:[]})).rejects.toMatchObject({statusCode:400});
  expect(await s.read(e.id)).toEqual(state);expect(await db.projectAward.count({where:{projectId:p.id}})).toBe(0);
 });
 it('clears awards and invalidates versions on direct move and deletion, including racing grants',async()=>{
  for(const kind of ['move','delete'] as const){const {e,p}=await fixture();const other=await db.exhibition.create({data:{year:2099,title:randomUUID()}});const s=service();const state=await s.change(e.id,0,{kind:'create',name:'Gold',builtinKey:'medal',assetId:null});
   await s.change(e.id,state.version,{kind:'project',projectId:p.id,awardIds:[state.items[0]!.id]});
   const version=(await s.read(e.id)).version;
   const results=await Promise.allSettled([s.change(e.id,version,{kind:'recipients',awardId:state.items[0]!.id,addProjectIds:[p.id],removeProjectIds:[]}),kind==='move'?db.project.update({where:{id:p.id},data:{exhibitionId:other.id}}):db.project.delete({where:{id:p.id}})]);
   expect(results[1].status).toBe('fulfilled');expect(await db.projectAward.count({where:{projectId:p.id}})).toBe(0);expect((await s.read(e.id)).version).toBeGreaterThan(version);
   if(kind==='move')expect((await db.project.findUniqueOrThrow({where:{id:p.id}})).sortOrder).toBe(71);
  }
 });
 it('requires a ready display representation, protects shared images and records durable cleanup',async()=>{
  const {e}=await fixture();const s=service();await db.storageBucket.upsert({where:{bucket:'pcu-public'},create:{bucket:'pcu-public',visibility:'PUBLIC'},update:{}});
  const asset=await db.asset.create({data:{exhibitionId:e.id,kind:'IMAGE',status:'PROCESSING',originalName:'award.png'}});
  const change={kind:'create' as const,name:'Image',builtinKey:null,assetId:asset.id};await expect(s.change(e.id,0,change)).rejects.toMatchObject({statusCode:400});
  await db.assetRepresentation.create({data:{assetId:asset.id,role:'ORIGINAL',state:'READY',bucket:'pcu-public',objectKey:`awards/${randomUUID()}.png`,mimeType:'image/png',sizeBytes:8n}});
  for(const role of ['CARD_480','DISPLAY_960'] as const)await db.assetRepresentation.create({data:{assetId:asset.id,role,state:'READY',bucket:'pcu-public',objectKey:`awards/${randomUUID()}.webp`,mimeType:'image/webp',sizeBytes:8n}});
  await db.asset.update({where:{id:asset.id},data:{status:'READY'}});
  let state=await s.change(e.id,0,change);state=await s.change(e.id,state.version,{...change,name:'Shared'});
  await expect(s.change(e.id,state.version,{kind:'asset-delete',assetId:asset.id})).rejects.toMatchObject({statusCode:409});
  for(const a of state.items)state=await s.change(e.id,state.version,{kind:'delete',awardId:a.id});
  expect(await db.asset.findUnique({where:{id:asset.id}})).not.toBeNull();
  const race=await Promise.allSettled([s.change(e.id,state.version,{...change,name:'Race'}),s.change(e.id,state.version,{kind:'asset-delete',assetId:asset.id})]);
  expect(race.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect((race.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.statusCode).toBe(409);
  state=await s.read(e.id);for(const award of state.items)state=await s.change(e.id,state.version,{kind:'delete',awardId:award.id});
  if(await db.asset.findUnique({where:{id:asset.id}}))await s.change(e.id,state.version,{kind:'asset-delete',assetId:asset.id});expect(await db.asset.findUnique({where:{id:asset.id}})).toBeNull();
  expect(await db.orphanObject.count({where:{reason:'award-image-delete'}})).toBe(3);
 });
 it('enforces composite ownership, duplicate links and exactly one display source in PostgreSQL',async()=>{
  const {e,p}=await fixture();const other=await fixture();const s=service();const state=await s.change(e.id,0,{kind:'create',name:'Gold',builtinKey:'medal',assetId:null});const awardId=state.items[0]!.id;
  await expect(db.projectAward.create({data:{exhibitionId:e.id,projectId:other.p.id,awardId}})).rejects.toThrow();
  await db.projectAward.create({data:{exhibitionId:e.id,projectId:p.id,awardId}});
  await expect(db.projectAward.create({data:{exhibitionId:e.id,projectId:p.id,awardId}})).rejects.toThrow();
  await expect(db.exhibitionAward.create({data:{exhibitionId:e.id,name:'Invalid',sortOrder:2,builtinKey:null,assetId:null}})).rejects.toThrow();
  await expect(db.exhibitionAward.create({data:{exhibitionId:e.id,name:'Invalid',sortOrder:2,builtinKey:'unknown',assetId:null}})).rejects.toThrow();
 });
 it('upgrades existing data atomically and rolls all new DDL back after injected failure',async()=>{
  const old=await createIsolatedMigratedDatabase(process.env['DATABASE_URL']!,migration);const client=old.createClient();
  try{await client.$executeRawUnsafe("INSERT INTO exhibitions (year,title,updated_at) VALUES (2099,'preserve',now())");const sql=await readFile(new URL(`../../prisma/migrations/${migration}/migration.sql`,import.meta.url),'utf8');
   await expect(client.$executeRawUnsafe(sql.replace('CREATE FUNCTION clear_moved_project_awards()', 'SELECT 1/0;\nCREATE FUNCTION clear_moved_project_awards()'))).rejects.toThrow();
   await client.$executeRawUnsafe('ROLLBACK');expect(await client.$queryRawUnsafe("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='exhibitions' AND column_name='awards_version'")).toEqual([]);
   expect(await client.$queryRawUnsafe("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename IN ('exhibition_awards','project_awards')")).toEqual([]);
   await client.$executeRawUnsafe(sql);expect(await client.exhibition.findFirst({where:{title:'preserve'}})).toMatchObject({awardsVersion:0});expect(await client.exhibitionAward.count()).toBe(0);
  }finally{await old.close();}
 },120000);
});
