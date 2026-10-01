import type { VisibilityActor as Actor } from '../../shared/visibility.js';
import type { FastifyPluginAsync } from 'fastify';
import type { Env } from '../../config/env.js';
import { notFound } from '../../shared/errors.js';
import type { FileAccessRepository } from './repository.js';
import { createFileAccessService, type RuntimeResolver } from './service.js';
export function createFileAccessController(repository: FileAccessRepository, config: Env, now = () => new Date(), presign?: (bucket:string,key:string,options?:{method?:'GET'|'HEAD';responseContentDisposition?:string})=>Promise<string>, checkDownload?: (assetId:number,variant:'original'|'playback',ip:string,actor:NonNullable<Actor>|undefined)=>Promise<unknown>, runtimeResolver?: RuntimeResolver) {
 const service=createFileAccessService(repository,config,now,presign,checkDownload,runtimeResolver);
 const plugin: FastifyPluginAsync=async app=>{
  app.addHook('onSend',async(_req,reply,payload)=>{reply.header('Cache-Control','private, no-store');return payload;});
  app.post<{Body:{url:string}}>('/file-access',async request=>{
   if(typeof request.body?.url!=='string') throw notFound();
   return {ok:true,data:await service.issue(request.body.url,request)};
  });
  app.post<{Params:{token:string}}>('/file-access/:token/renew',request=>service.renew(request.params.token,request));
  app.get('/internal/file-access',{config:{rateLimit:false}},async(request,reply)=>{
   const path=await service.check(request.headers);
   if ('csp' in path && typeof path.csp === 'string') reply.header('X-PCU-Runtime-CSP',path.csp);
   reply.header('X-PCU-Object-Path',path.path).header('X-PCU-Upstream-Host',path.host).status(204).send();
  });
 };
 return Object.assign(plugin,{issue:service.issue});
}
