import { createAssetsService } from '../modules/assets/service.js';
import { createAssetsRepository } from '../modules/assets/repository.js';
import { createAssetDeletionUnitOfWork } from '../modules/assets/deletion.repository.js';
import { createFileAccessService } from '../modules/file-access/service.js';
import { randomUUID } from 'node:crypto';
import Fastify, {type FastifyInstance} from 'fastify';
import cookie from '@fastify/cookie';
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod';
import { registerRouteSchemas } from '../shared/http-route-schemas.js';
import {beforeAll,afterAll,it,expect,describe,vi} from 'vitest';
import type {PrismaClient} from '../generated/prisma/client.js';
import {createIsolatedMigratedDatabase} from './helpers/isolated-migrated-database.js';
import {createFileAccessController} from '../modules/file-access/controller.js';
import {createFileAccessRepository} from '../modules/file-access/repository.js';
import {registerAuth} from '../plugins/auth.js';
import {AppError} from '../shared/errors.js';
import type {Env} from '../config/env.js';

describe.runIf(process.env['RUN_POSTGRES_INTEGRATION']==='true')('live file capability HTTP boundary',()=>{
 let db:PrismaClient, app:FastifyInstance, database:Awaited<ReturnType<typeof createIsolatedMigratedDatabase>>;
 let owner:number, stranger:number, sid:string, otherSid:string, projectId:number, deploymentId:string;
 let time=new Date();
 let repository: ReturnType<typeof createFileAccessRepository>;
 const checkDownloadLimit = vi.fn(async () => {});
 const secret='file-access-integration-secret-32chars';
 const origin='http://localhost:5173';
 const key='public/images/test/image %.png';
 const image='http://files.test/'+key.split('/').map(encodeURIComponent).join('/');
 beforeAll(async()=>{
  database=await createIsolatedMigratedDatabase(process.env['DATABASE_URL']!);db=database.createClient();
  const a=await db.user.create({data:{googleSub:randomUUID(),email:randomUUID()+'@test.invalid'}});owner=a.id;
  const b=await db.user.create({data:{googleSub:randomUUID(),email:randomUUID()+'@test.invalid'}});stranger=b.id;
  sid=(await db.authSession.create({data:{userId:owner,expiresAt:new Date(time.getTime()+3600000)}})).id;
  otherSid=(await db.authSession.create({data:{userId:stranger,expiresAt:new Date(time.getTime()+3600000)}})).id;
  await db.storageBucket.createMany({data:[{bucket:'public',visibility:'PUBLIC'},{bucket:'protected',visibility:'PROTECTED'}]});
  const ex=await db.exhibition.create({data:{year:2098,title:randomUUID(),visibility:'STAFF'}});
  const project=await db.project.create({data:{exhibitionId:ex.id,creatorId:owner,slug:randomUUID(),title:'Restricted',status:'PUBLISHED',visibility:'AUTHENTICATED'}});projectId=project.id;
  await db.asset.create({data:{projectId,kind:'IMAGE',representations:{create:[{role:'ORIGINAL',bucket:'public',objectKey:key,state:'READY',mimeType:'image/png'},{role:'CARD_480',bucket:'public',objectKey:key+'-card',state:'READY',mimeType:'image/webp'},{role:'DISPLAY_960',bucket:'public',objectKey:key+'-display',state:'READY',mimeType:'image/webp'}]}}});
  await db.asset.create({data:{projectId,kind:'VIDEO',representations:{create:[{role:'ORIGINAL',bucket:'protected',objectKey:'video-original.mp4',state:'READY',mimeType:'video/mp4'},{role:'PLAYBACK',bucket:'protected',objectKey:'video.mp4',state:'READY',mimeType:'video/mp4'}]}}});
  const source=await db.asset.create({data:{projectId,kind:'WEBGL',representations:{create:{role:'WEBGL_SOURCE',bucket:'protected',objectKey:'source.zip',state:'READY',mimeType:'application/octet-stream'}}},include:{representations:true}});
  deploymentId=randomUUID();const prefix=`public/webgl/${projectId}/${deploymentId}/`;
  await db.webglDeployment.create({data:{id:deploymentId,projectId,sourceRepresentationId:source.representations[0]!.id,publicBucket:'public',publicPrefix:prefix,entryObjectKey:prefix+'index.html',state:'READY',objectManifest:{version:1,objects:[{objectKey:prefix+'index.html',sizeBytes:'1',mimeType:'text/html'},{objectKey:prefix+'Build/game.wasm',sizeBytes:'1',mimeType:'application/wasm'},{objectKey:prefix+'Build/100%.wasm',sizeBytes:'1',mimeType:'application/wasm'}]}}});
  await db.project.update({where:{id:projectId},data:{currentWebglDeploymentId:deploymentId}});
  const config={API_PUBLIC_URL:'http://api.test',PUBLIC_ASSET_ORIGIN:'http://files.test',S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT:'http://protected.test',S3_BUCKET_PUBLIC:'public',S3_BUCKET_PROTECTED:'protected',SESSION_COOKIE_NAME:'sid',SESSION_IDLE_MS:3600000,FILE_GATEWAY_SECRET:secret} as Env;
  app=Fastify();app.setValidatorCompiler(validatorCompiler);app.setSerializerCompiler(serializerCompiler);await app.register(cookie);
  await registerAuth(app,{config:{...config,SESSION_TOUCH_MIN_INTERVAL_MS:3600000,COOKIE_SECURE:false,COOKIE_SAME_SITE:'lax',CORS_ALLOWED_ORIGINS:[origin]},clock:{now:()=>time},logger:app.log,sessions:{find:id=>db.authSession.findUnique({where:{id},include:{user:true}}),touch:async()=>{},delete:async id=>{await db.authSession.delete({where:{id}});}}});
  app.setErrorHandler((error,_request,reply)=>reply.status(error instanceof AppError?error.statusCode:500).send({ok:false,error:{code:error instanceof AppError?error.code:'INTERNAL_ERROR',message:error instanceof Error?error.message:'Unknown error'}}));
  registerRouteSchemas(app);
  repository = createFileAccessRepository(db);
  await app.register(createFileAccessController(createFileAccessService(repository,config,()=>time,async(bucket,key)=>`http://protected.test/${bucket}/${key}?signedAt=${time.getTime()}`,createAssetsService({ protectedBucket: 'protected',repository:createAssetsRepository(db),deletion:createAssetDeletionUnitOfWork(db),checkDownloadLimit,wakeDeletionWorker:()=>{},logger:app.log}).prepareAssetDownload)),{prefix:'/api'});
 });
 afterAll(async()=>{await app?.close();await database?.close();});
 const issue=(url:string,session=sid)=>app.inject({method:'POST',url:'/api/file-access',headers:{origin,cookie:'sid='+session},payload:{url}});
 const gate=(url:string,kind='public')=>{const u=new URL(url);return app.inject({url:'/api/internal/file-access',headers:{'x-pcu-gateway-secret':secret,'x-pcu-file-kind':kind,'x-pcu-file-uri':u.pathname+u.search}});};
 it('issues public image URLs without duplicate actor lookup and rechecks current visibility at the gateway',async()=>{
  const exhibition = await db.exhibition.create({data:{year:2097,title:randomUUID(),visibility:'PUBLIC'}});
  const project = await db.project.create({data:{exhibitionId:exhibition.id,creatorId:owner,slug:randomUUID(),title:'Public image',status:'PUBLISHED',visibility:'PUBLIC'}});
  const asset = await db.asset.create({data:{projectId:project.id,kind:'IMAGE',status:'READY',representations:{create:(['ORIGINAL','CARD_480','DISPLAY_960'] as const).map(role=>({role,bucket:'public',objectKey:'public/images/public-image-'+role+'.png',state:'READY',mimeType:'image/png'}))}}});
  const url = 'http://files.test/public/images/public-image-ORIGINAL.png';
  const deploymentLookup = vi.spyOn(repository,'findDeployment');
  const representationLookup = vi.spyOn(repository,'findRepresentation');
  const votePosterLookup = vi.spyOn(repository,'votePoster');
  checkDownloadLimit.mockClear();
  try {
   for (const session of [undefined,sid]) {
    deploymentLookup.mockClear();representationLookup.mockClear();votePosterLookup.mockClear();
    const response = await app.inject({method:'POST',url:'/api/file-access',headers:{origin,...(session?{cookie:'sid='+session}:{})},payload:{url}});
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ok:true,data:{url,token:null,expiresAt:null}});
    expect(response.headers['cache-control']).toBe('private, no-store');
    // Two independent checks: requesting actor and anonymous accessibility.
    // Count repository lookups, without fixing their internal call order or SQL.
    expect(deploymentLookup.mock.calls.length+representationLookup.mock.calls.length+votePosterLookup.mock.calls.length).toBe(6);
   }
   expect(checkDownloadLimit).not.toHaveBeenCalled();
   expect((await gate(url)).statusCode).toBe(204);
   await db.exhibition.update({where:{id:exhibition.id},data:{visibility:'STAFF'}});
   expect((await gate(url)).statusCode).toBe(403);
  } finally {
   deploymentLookup.mockRestore();representationLookup.mockRestore();votePosterLookup.mockRestore();
   await db.asset.delete({where:{id:asset.id}});
   await db.project.delete({where:{id:project.id}});
   await db.exhibition.delete({where:{id:exhibition.id}});
  }
 });
 it('authorizes protected object issuance before applying the limiter',async()=>{
  const url = 'http://protected.test/protected/video-original.mp4';
  checkDownloadLimit.mockClear();
  expect((await issue(url,otherSid)).statusCode).toBe(403);
  expect(checkDownloadLimit).not.toHaveBeenCalled();
  const response = await issue(url);
  expect(response.statusCode).toBe(200);
  const grant = response.json().data;
  expect(grant.url).toBe('http://protected.test/file/'+grant.token);
  expect(checkDownloadLimit).toHaveBeenCalledTimes(1);
  expect((await gate(grant.url,'protected')).statusCode).toBe(204);
 });
 it('blocks raw known paths and unrelated sessions, allows session-bound owner token and revokes on visibility/relationship changes',async()=>{
  expect((await gate(image)).statusCode).toBe(403);
  expect((await issue(image,otherSid)).statusCode).toBe(403);
  const grant=(await issue(image)).json().data;
  expect((await gate(grant.url)).statusCode).toBe(204);
  expect((await gate(grant.url)).headers['x-pcu-object-path']).toContain('%25');
  expect((await app.inject({url:'/api/internal/file-access',headers:{'x-pcu-file-uri':'/test'}})).statusCode).toBe(403);
  await db.project.update({where:{id:projectId},data:{creatorId:stranger}});
  expect((await gate(grant.url)).statusCode).toBe(403);
  await db.project.update({where:{id:projectId},data:{creatorId:owner}});
  await db.fileAccessToken.update({where:{id:grant.token},data:{expiresAt:new Date(time.getTime()-1)}});
  expect((await gate(grant.url)).statusCode).toBe(403);
 });
 it('keeps protected URL stable across renewal while minting fresh upstream signatures; logout blocks it',async()=>{
  const asset=await db.asset.findFirstOrThrow({where:{projectId,kind:'VIDEO'}});
  const grant=(await issue(`http://api.test/api/assets/${asset.id}/download?variant=playback`)).json().data;
  expect(grant.url).toBe('http://protected.test/file/'+grant.token);
  const first=await gate(grant.url,'protected');expect(first.statusCode).toBe(204);
  time=new Date(time.getTime()+30000);
  const renewed=await app.inject({method:'POST',url:`/api/file-access/${grant.token}/renew`,headers:{origin,cookie:'sid='+sid}});
  expect(renewed.statusCode).toBe(200);expect(renewed.json().data.token).toBe(grant.token);
  time=new Date(time.getTime()+45000);
  const later=await gate(grant.url,'protected');expect(later.statusCode).toBe(204);
  expect(later.headers['x-pcu-object-path']).not.toBe(first.headers['x-pcu-object-path']);
  await db.authSession.delete({where:{id:sid}});expect((await gate(grant.url,'protected')).statusCode).toBe(403);
  sid=(await db.authSession.create({data:{userId:owner,expiresAt:new Date(time.getTime()+3600000)}})).id;
 });
 it('allows manifest-only relative WebGL paths and rejects other deployments, traversal and removed deployment',async()=>{
  const dep=await db.webglDeployment.findUniqueOrThrow({where:{id:deploymentId}});
  const grant=(await issue('http://files.test/'+dep.entryObjectKey)).json().data;
  expect(grant.url).toContain('/play/'+grant.token+'/index.html');
  expect((await gate(grant.url)).statusCode).toBe(204);
  expect((await gate(grant.url.replace('index.html','Build/game.wasm'))).statusCode).toBe(204);
  const percentGrant=(await issue('http://files.test/'+dep.publicPrefix+'Build/100%25.wasm')).json().data;
  expect(percentGrant.url).toContain('100%25.wasm');
  expect((await gate(percentGrant.url)).statusCode).toBe(204);
  expect((await gate(grant.url.replace('index.html','secret.txt'))).statusCode).toBe(403);
  const traversal=await app.inject({url:'/api/internal/file-access',headers:{'x-pcu-gateway-secret':secret,'x-pcu-file-kind':'public','x-pcu-file-uri':`/play/${grant.token}/%2e%2e/secret`}});
  expect(traversal.statusCode).toBe(403);
  await db.project.update({where:{id:projectId},data:{currentWebglDeploymentId:null}});
  expect((await gate(grant.url)).statusCode).toBe(403);
 });
});
