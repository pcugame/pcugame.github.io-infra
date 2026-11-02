import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AwardState } from '@pcu/contracts';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';
const enabled=process.env['RUN_GATEWAY_INTEGRATION']==='true'&&process.env['RUN_GARAGE_INTEGRATION']==='true'&&process.env['RUN_POSTGRES_INTEGRATION']==='true';
const api=process.env['GATEWAY_API_ORIGIN']??'http://localhost:4000';
describe.runIf(enabled)('award upload, worker, gateway and cleanup',()=>{
 let db:PrismaClient, sid:string,userId:number,exhibitionId:number;
 async function request(path:string,method='GET',body?:unknown){return fetch(api+path,{method,headers:{origin:'http://localhost:5173',cookie:`sid=${sid}`,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});}
 async function json<T>(path:string,method='GET',body?:unknown):Promise<T>{const response=await request(path,method,body);expect(response.ok,await response.clone().text()).toBe(true);return (await response.json() as {data:T}).data;}
 beforeAll(async()=>{
  db=createPrismaClientForDatabase(process.env['DATABASE_URL']!);
  userId=(await db.user.create({data:{role:'ADMIN',googleSub:randomUUID(),email:`${randomUUID()}@test.invalid`}})).id;
  sid=(await db.authSession.create({data:{userId,expiresAt:new Date(Date.now()+600000)}})).id;
  exhibitionId=(await db.exhibition.create({data:{year:2099,title:randomUUID()}})).id;
 });
 afterAll(async()=>{if(exhibitionId){const deleted=await request(`/api/admin/exhibitions/${exhibitionId}`,'DELETE');expect(deleted.status,await deleted.text()).toBe(204);}if(userId)await db.user.delete({where:{id:userId}});await db?.$disconnect();});
 it('uploads transparent PNG to Garage, selects worker output, preserves shared images, revokes gateway access and deletes explicitly',async()=>{
  const bytes=await sharp({create:{width:16,height:16,channels:4,background:{r:200,g:0,b:0,alpha:0.25}}}).png().toBuffer();
  const digest=createHash('sha256').update(bytes).digest();const header=Buffer.alloc(16);header.writeBigUInt64BE(BigInt(bytes.length));header.writeUInt32BE(1048576,8);header.writeUInt32BE(1,12);
  const proof={sourceIdentityAlgorithm:'SHA256_BLOCK_MANIFEST_V1',sourceIdentity:createHash('sha256').update(Buffer.from('PCU-UPLOAD-SOURCE-V1\0')).update(header).update(digest).digest('hex'),sourceIdentityBlockSizeBytes:1048576,sourceIdentityBlockDigests:[digest.toString('hex')]};
  const upload=await json<{sessionId:string;generation:number}>(`/api/admin/exhibitions/${exhibitionId}/direct-image-upload-sessions`,'POST',{originalName:'award.png',totalBytes:bytes.length,declaredMimeType:'image/png',...proof});
  const root=`/api/admin/direct-asset-upload-sessions/${upload.sessionId}`;
  const signed=await json<{parts:{url:string;requiredHeaders:Record<string,string>}[]}>(`${root}/part-urls`,'POST',{generation:upload.generation,parts:[{partNumber:1,checksumSha256:digest.toString('base64')}]});
  const part=signed.parts[0]!;const put=await fetch(part.url,{method:'PUT',headers:part.requiredHeaders,body:new Uint8Array(bytes)});expect(put.ok,await put.clone().text()).toBe(true);
  await json(`${root}/complete`,'POST',{generation:upload.generation,parts:[{partNumber:1,sizeBytes:bytes.length,etag:put.headers.get('etag')}]});
  let ready=false;for(let i=0;i<120;i++){const status=await json<{state:string}>(root);if(status.state==='READY'){ready=true;break;}expect(status.state).not.toBe('REJECTED');await new Promise(r=>setTimeout(r,250));}expect(ready).toBe(true);
  const awardRoot=`/api/admin/exhibitions/${exhibitionId}/awards`;let state=await json<AwardState>(awardRoot);expect(state.assets).toHaveLength(1);const asset=state.assets[0]!;expect(asset.imageUrl).toBeTruthy();
  for(const name of ['Gold','Special'])state=await json<AwardState>(awardRoot,'POST',{expectedVersion:state.version,name,builtinKey:null,assetId:asset.id});
  const image=await fetch(asset.imageUrl!);expect(image.status).toBe(200);const metadata=await sharp(Buffer.from(await image.arrayBuffer())).metadata();expect(metadata.hasAlpha).toBe(true);
  expect((await request(`/api/admin/exhibitions/${exhibitionId}/award-images/${asset.id}`,'DELETE',{expectedVersion:state.version})).status).toBe(409);
  await db.exhibition.update({where:{id:exhibitionId},data:{visibility:'STAFF'}});
  expect((await fetch(asset.imageUrl!)).status).toBe(403);
  const grant=await json<{url:string}>('/api/file-access','POST',{url:asset.imageUrl});expect((await fetch(grant.url)).status).toBe(200);
  await db.authSession.delete({where:{id:sid}});expect((await fetch(grant.url)).status).toBe(403);
  sid=(await db.authSession.create({data:{userId,expiresAt:new Date(Date.now()+600000)}})).id;
  for(const award of state.items)state=await json<AwardState>(`${awardRoot}/${award.id}`,'DELETE',{expectedVersion:state.version});
  expect(await db.asset.findUnique({where:{id:asset.id}})).not.toBeNull();
  await json(`/api/admin/exhibitions/${exhibitionId}/award-images/${asset.id}`,'DELETE',{expectedVersion:state.version});expect(await db.asset.findUnique({where:{id:asset.id}})).toBeNull();expect((await fetch(asset.imageUrl!)).status).toBe(403);
 },60000);
 it('rejects unsupported declared formats, cancels an unfinished upload and cleans a remaining active session on exhibition deletion',async()=>{
  const bytes=Buffer.from('cancel-fixture');const digest=createHash('sha256').update(bytes).digest();const header=Buffer.alloc(16);header.writeBigUInt64BE(BigInt(bytes.length));header.writeUInt32BE(1048576,8);header.writeUInt32BE(1,12);
  const body={originalName:'cancel.png',totalBytes:bytes.length,declaredMimeType:'image/png',sourceIdentityAlgorithm:'SHA256_BLOCK_MANIFEST_V1',sourceIdentity:createHash('sha256').update(Buffer.from('PCU-UPLOAD-SOURCE-V1\0')).update(header).update(digest).digest('hex'),sourceIdentityBlockSizeBytes:1048576,sourceIdentityBlockDigests:[digest.toString('hex')]};
  const path=`/api/admin/exhibitions/${exhibitionId}/direct-image-upload-sessions`;
  expect((await request(path,'POST',{...body,declaredMimeType:'image/gif'})).status).toBe(400);
  const first=await json<{sessionId:string}>(path,'POST',body);
  expect((await request(`/api/admin/direct-asset-upload-sessions/${first.sessionId}`,'DELETE')).status).toBe(204);
  expect((await db.assetUploadSession.findUniqueOrThrow({where:{id:first.sessionId}})).state).toBe('CANCELLED');
  const active=await json<{sessionId:string}>(path,'POST',body);
  const source=await db.assetUploadSession.findUniqueOrThrow({where:{id:active.sessionId}});
  const removed=await request(`/api/admin/exhibitions/${exhibitionId}`,'DELETE');expect(removed.status,await removed.text()).toBe(204);
  expect(await db.assetUploadSession.count({where:{exhibitionId}})).toBe(0);
  expect(await db.orphanObject.findFirst({where:{bucket:source.bucket,storageKey:source.objectKey}})).not.toBeNull();
  expect(await db.multipartAbortTask.findFirst({where:{bucket:source.bucket,storageKey:source.objectKey}})).not.toBeNull();
  exhibitionId=0;
 });

});
