import type { FastifyPluginAsync } from 'fastify';
import { notFound } from '../../shared/errors.js';
import type { FileAccessService } from './ports.js';
export function createFileAccessController(service: FileAccessService) {
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
 return plugin;
}
