import { deleteProjectInTransaction } from './transaction.js';
import { AppError } from '../../shared/errors.js';
import { validatorCompiler, serializerCompiler } from '@fastify/type-provider-zod';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectChangeDetailSchema, ProjectChangeListResponseSchema } from '@pcu/contracts';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { createIsolatedMigratedDatabase } from '../../__tests__/helpers/isolated-migrated-database.js';
import { registerAuth } from '../../plugins/auth.js';
import { registerRouteSchemas } from '../../shared/http-route-schemas.js';
import { createProjectChangeRepository } from './repository.js';
import { createProjectChangeService } from './service.js';
import { createProjectChangeController } from './controller.js';
import { createProjectPublicationRepository } from '../project-publication/repository.js';
import { createAssetsRepository } from '../assets/repository.js';
import { createProjectCrudRepository } from '../admin/project/crud.repository.js';
import type { ChangeActor } from './ports.js';

describe.runIf(process.env['RUN_POSTGRES_INTEGRATION']==='true')('change request authenticated PostgreSQL boundaries',()=>{
 let db:PrismaClient,database:Awaited<ReturnType<typeof createIsolatedMigratedDatabase>>,app:FastifyInstance,service:ReturnType<typeof createProjectChangeService>,owner:ChangeActor,member:ChangeActor,operator:ChangeActor,stranger:ChangeActor;
 let exhibitionId:number;const userIds:number[]=[];const sessions=new Map<number,string>();let protectedBucket:string;
 beforeAll(async()=>{
  database=await createIsolatedMigratedDatabase(process.env['DATABASE_URL']!);db=database.createClient();
  protectedBucket=(await db.storageBucket.findUnique({where:{visibility:'PROTECTED'}}))?.bucket??'request-protected';
  await db.storageBucket.upsert({where:{visibility:'PROTECTED'},create:{bucket:protectedBucket,visibility:'PROTECTED'},update:{}});
  await db.storageBucket.upsert({where:{visibility:'PUBLIC'},create:{bucket:'request-public',visibility:'PUBLIC'},update:{}});
  async function user(role:'USER'|'OPERATOR'){const row=await db.user.create({data:{googleSub:randomUUID(),email:`${randomUUID()}@example.test`,role}});userIds.push(row.id);const session=await db.authSession.create({data:{userId:row.id,expiresAt:new Date(Date.now()+3600000)}});sessions.set(row.id,session.id);return {id:row.id,role};}
  owner=await user('USER');member=await user('USER');operator=await user('OPERATOR');stranger=await user('USER');
  exhibitionId=(await db.exhibition.create({data:{year:2097,title:randomUUID(),isModificationEnabled:false}})).id;
  service=createProjectChangeService(createProjectChangeRepository(db));app=Fastify();app.setValidatorCompiler(validatorCompiler);app.setSerializerCompiler(serializerCompiler);await app.register(cookie);
  await registerAuth(app,{config:{SESSION_COOKIE_NAME:'sid',SESSION_IDLE_MS:3600000,SESSION_TOUCH_MIN_INTERVAL_MS:3600000,COOKIE_SECURE:false,COOKIE_SAME_SITE:'lax',CORS_ALLOWED_ORIGINS:['http://localhost:5173']},clock:{now:()=>new Date()},sessions:{find:id=>db.authSession.findUnique({where:{id},include:{user:true}}),delete:async id=>{await db.authSession.delete({where:{id}});},touch:async(id,at)=>{await db.authSession.update({where:{id},data:{lastSeenAt:at}});}},logger:app.log});
  app.setErrorHandler((error,_request,reply)=>{const status=error instanceof AppError?error.statusCode:500;reply.status(status).send({ok:false,error:{code:error instanceof AppError?error.code:'ERROR',message:error instanceof Error?error.message:'Error'}});});
  registerRouteSchemas(app);await app.register(createProjectChangeController(service,'me'),{prefix:'/api/me'});await app.register(createProjectChangeController(service,'admin'),{prefix:'/api/admin'});
 });
 afterAll(async()=>{if(!db)return;await app?.close();await database?.close();});
 async function project(){return db.project.create({data:{exhibitionId,creatorId:owner.id,slug:randomUUID(),title:'Original',status:'PUBLISHED',members:{create:{userId:member.id,name:'Member'}}}});}
 function request(actor:ChangeActor,method:'GET'|'POST'|'PATCH',url:string,payload?:unknown){return app.inject({method,url,headers:{cookie:`sid=${sessions.get(actor.id)}`,origin:'http://localhost:5173'},...(payload!==undefined?{payload:payload as Record<string,unknown>}:{})});}
 async function draft(projectId:number,actor=owner){return service.create(actor,projectId,{kind:'EDIT',reason:'Correct published data'});}
 it('authenticates create/update/read/list/submit/approval and serializes empty collections',async()=>{
  const p=await project();const created=await request(owner,'POST',`/api/me/projects/${p.id}/change-requests`,{kind:'EDIT',reason:'Correction'});expect(created.statusCode).toBe(201);const body=ProjectChangeDetailSchema.parse(created.json().data);expect(body.items).toEqual([]);expect(body.stagedAssets).toEqual([]);
  expect((await request(stranger,'GET',`/api/me/change-requests/${body.id}`)).statusCode).toBe(403);
  expect((await request(member,'PATCH',`/api/me/change-requests/${body.id}`,{changes:{title:'Other member edit'}})).statusCode).toBe(403);
  const edited=await request(owner,'PATCH',`/api/me/change-requests/${body.id}`,{changes:{title:'Approved title',members:[{name:'New member',studentId:''}]}});expect(edited.statusCode).toBe(200);ProjectChangeDetailSchema.parse(edited.json().data);
  expect((await db.project.findUniqueOrThrow({where:{id:p.id}})).title).toBe('Original');
  expect((await request(owner,'POST',`/api/me/change-requests/${body.id}/submit`)).statusCode).toBe(200);
  expect((await request(owner,'POST',`/api/admin/change-requests/${body.id}/approve`)).statusCode).toBe(403);
  const approved=await request(operator,'POST',`/api/admin/change-requests/${body.id}/approve`);expect(approved.statusCode).toBe(200);expect(ProjectChangeDetailSchema.parse(approved.json().data).state).toBe('COMPLETED');
  expect((await db.project.findUniqueOrThrow({where:{id:p.id}})).title).toBe('Approved title');
  const list=await request(owner,'GET',`/api/me/projects/${p.id}/change-requests`);expect(list.statusCode).toBe(200);expect(ProjectChangeListResponseSchema.parse(list.json().data).total).toBe(1);
 });
 it('enforces one active request under concurrent creator/member submission',async()=>{const p=await project();const result=await Promise.allSettled([draft(p.id),draft(p.id,member)]);expect(result.filter(item=>item.status==='fulfilled')).toHaveLength(1);expect(result.find(item=>item.status==='rejected')).toMatchObject({reason:{statusCode:409}});});
 it('keeps closed project intact on reject/cancel and blocks edits after submit',async()=>{const p=await project();const d=await draft(p.id);await service.update(owner,d.id,{changes:{title:'Unapproved'}});await service.submit(owner,d.id);await expect(service.update(owner,d.id,{changes:{title:'Sneak'}})).rejects.toMatchObject({statusCode:409});await service.reject(operator,d.id,'Needs clarification');expect((await service.detail(owner,d.id)).state).toBe('REJECTED');const d2=await draft(p.id);await service.cancel(owner,d2.id);expect((await db.project.findUniqueOrThrow({where:{id:p.id}})).title).toBe('Original');});
 it('detects direct-change conflicts and removed requester membership',async()=>{const p=await project();const d=await draft(p.id,member);await service.update(member,d.id,{changes:{title:'Member draft'}});await service.submit(member,d.id);await db.projectMember.deleteMany({where:{projectId:p.id,userId:member.id}});expect((await service.approve(operator,d.id)).state).toBe('CONFLICT');const d2=await draft(p.id);await service.submit(owner,d2.id);await db.project.update({where:{id:p.id},data:{version:{increment:1},title:'Direct admin change'}});expect((await service.approve(operator,d2.id)).state).toBe('CONFLICT');expect((await db.project.findUniqueOrThrow({where:{id:p.id}})).title).toBe('Direct admin change');});
 it('fences a pending request after the first production deletion claim without double-bumping a retry',async()=>{const p=await project();const asset=await db.asset.create({data:{projectId:p.id,kind:'DOCUMENT',status:'READY',representations:{create:{role:'ORIGINAL',state:'READY',bucket:protectedBucket,objectKey:`requests-test/${randomUUID()}`,mimeType:'application/pdf',sizeBytes:1n}}}});const d=await service.create(owner,p.id,{kind:'DELETE',reason:'Withdraw after asset claim'});await service.submit(owner,d.id);const assets=createAssetsRepository(db);await assets.claimAssetForDeletion(asset.id);expect((await db.project.findUniqueOrThrow({where:{id:p.id}})).version).toBe(p.version+1);expect((await service.approve(operator,d.id)).state).toBe('CONFLICT');await assets.claimAssetForDeletion(asset.id);expect((await db.project.findUniqueOrThrow({where:{id:p.id}})).version).toBe(p.version+1);});
 it('fences a pending request after an operator bulk status update',async()=>{
  const p=await project();const d=await draft(p.id);await service.submit(owner,d.id);
  await expect(createProjectCrudRepository(db).bulkUpdateStatus([p.id],'ARCHIVED')).resolves.toMatchObject({count:1});
  const updated=await db.project.findUniqueOrThrow({where:{id:p.id}});
  expect(updated).toMatchObject({status:'ARCHIVED',version:p.version+1});
  expect((await service.approve(operator,d.id)).state).toBe('CONFLICT');
 });
 it('applies simultaneous duplicate approvals once',async()=>{const p=await project();const d=await draft(p.id);await service.update(owner,d.id,{changes:{title:'Once'}});await service.submit(owner,d.id);const results=await Promise.all([service.approve(operator,d.id),service.approve(operator,d.id)]);expect(results.map(row=>row.state)).toEqual(['COMPLETED','COMPLETED']);expect((await db.project.findUniqueOrThrow({where:{id:p.id}})).version).toBe(p.version+1);});
 it('source deletion cancels draft uploads and preserves conflicted request history',async()=>{const p=await project();const d=await draft(p.id);const staged=await service.update(owner,d.id,{manifest:[{kind:'GAME',slot:'game',clientToken:'c'.repeat(32)}]});await db.$transaction(tx=>deleteProjectInTransaction(tx,p.id));expect(await db.project.findUnique({where:{id:staged.stagingProjectId!}})).toBeNull();expect(await service.detail(owner,d.id)).toMatchObject({state:'CONFLICT',projectId:null,stagingProjectId:null});});
 it('permanently deletes only on approval while preserving history and durable cleanup',async()=>{const p=await project();const key=`requests-test/${randomUUID()}`;await db.asset.create({data:{projectId:p.id,kind:'GAME',representations:{create:{role:'ORIGINAL',state:'READY',bucket:protectedBucket,objectKey:key,mimeType:'application/zip',sizeBytes:10n}}}});const d=await service.create(owner,p.id,{kind:'DELETE',reason:'Withdraw submission'});await service.submit(owner,d.id);expect(await db.project.findUnique({where:{id:p.id}})).not.toBeNull();const result=await service.approve(operator,d.id);expect(result).toMatchObject({state:'COMPLETED',projectId:null,originalProjectId:p.id});expect(await db.project.findUnique({where:{id:p.id}})).toBeNull();expect(await db.orphanObject.findUnique({where:{orphan_bucket_storage_key:{bucket:protectedBucket,storageKey:key}}})).not.toBeNull();});
 it('rejects foreign asset references and pending upload submission',async()=>{const p=await project();const d=await draft(p.id);await service.update(owner,d.id,{changes:{removeAssetIds:[99999999]}});await expect(service.submit(owner,d.id)).rejects.toMatchObject({statusCode:403});const staged=await service.update(owner,d.id,{changes:{},manifest:[{kind:'GAME',slot:'game',clientToken:'g'.repeat(32)}]});expect(staged.stagingProjectId).not.toBeNull();expect(staged.items).toHaveLength(1);await expect(service.submit(owner,d.id)).rejects.toMatchObject({statusCode:409});await service.cancel(owner,d.id);expect(await db.project.findUnique({where:{id:staged.stagingProjectId!}})).toBeNull();});
 it('transfers a READY private staged game atomically without publishing its staging project',async()=>{
  const p=await project();const d=await draft(p.id);const stage=await service.update(owner,d.id,{changes:{title:'With replacement'},manifest:[{kind:'GAME',slot:'game',clientToken:'a'.repeat(32)}]});
  const asset=await db.asset.create({data:{projectId:stage.stagingProjectId!,kind:'GAME',status:'READY',originalName:'game.zip',representations:{create:{role:'ORIGINAL',state:'READY',bucket:protectedBucket,objectKey:`requests-test/${randomUUID()}`,sizeBytes:10n,mimeType:'application/zip',sourceIdentityAlgorithm:'SHA256',sourceIdentity:'abc'}}},include:{representations:true}});
  const rep=asset.representations[0]!;
  await db.assetUploadSession.create({data:{projectId:stage.stagingProjectId!,userId:owner.id,kind:'GAME',state:'READY',originalName:'game.zip',totalBytes:10n,partSizeBytes:10,totalParts:1,bucket:protectedBucket,objectKey:rep.objectKey,sourceIdentityAlgorithm:'SHA256',sourceIdentity:'abc',sourceIdentityBlockSizeBytes:10,sourceIdentityBlockManifest:[],expiresAt:new Date(Date.now()+3600000),resultAssetId:asset.id,resultRepresentationId:rep.id,submissionItemId:stage.items[0]!.id}});
  await db.projectSubmissionItem.update({where:{id:stage.items[0]!.id},data:{state:'READY',boundGeneration:1,resultAssetId:asset.id,resultRepresentationId:rep.id}});
  const detail=await request(owner,'GET',`/api/me/change-requests/${d.id}`);expect(detail.statusCode).toBe(200);expect(ProjectChangeDetailSchema.parse(detail.json().data).stagedAssets).toHaveLength(1);
  await service.submit(owner,d.id);expect((await service.approve(operator,d.id)).state).toBe('APPLYING');expect((await db.project.findUniqueOrThrow({where:{id:p.id}})).title).toBe('Original');
  const publication=createProjectPublicationRepository(db);const token=randomUUID();const job=await publication.claim({token,leaseMs:60000});expect(job?.projectId).toBe(stage.stagingProjectId);const failed=await publication.fail(job!.id,token,'Simulated worker failure');expect(failed).toBe(true);expect((await service.detail(owner,d.id)).state).toBe('FAILED');expect((await db.project.findUniqueOrThrow({where:{id:p.id}})).title).toBe('Original');await service.retry(operator,d.id);const retryJob=await publication.claim({token,leaseMs:60000});const validated=await publication.validatePlan(retryJob!,token);expect(validated.status).toBe('VALID');if(validated.status!=='VALID')throw new Error('Validation failed');expect(await publication.complete(validated.job,token)).toBe('COMPLETED');expect(await publication.complete(validated.job,token)).toBe('COMPLETED');
  expect((await db.asset.findUniqueOrThrow({where:{id:asset.id}})).projectId).toBe(p.id);expect((await db.project.findUniqueOrThrow({where:{id:p.id}})).title).toBe('With replacement');expect((await db.project.findUniqueOrThrow({where:{id:stage.stagingProjectId!}})).status).toBe('DRAFT');expect((await service.detail(owner,d.id)).state).toBe('COMPLETED');expect((await service.detail(owner,d.id)).stagedAssets[0]?.originalName).toBe('game.zip');
 });
});
