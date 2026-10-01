import type { FastifyPluginAsync } from 'fastify';
import { requireLogin, requireRole } from '../../shared/auth-guards.js';
import { sendCreated, sendOk } from '../../shared/http.js';
import { parseIntParam } from '../../shared/validation.js';
import type { createWebglNetworkService } from './service.js';
export function createWebglNetworkController(service: ReturnType<typeof createWebglNetworkService>, audience: 'me' | 'admin'): FastifyPluginAsync {
 return async app => {
  app.addHook('onSend', async (_request, reply, payload) => { reply.header('Cache-Control', 'private, no-store'); return payload; });
  if (audience === 'me') {
   app.get<{ Params: { id: string } }>('/projects/:id/webgl-network-requests', { preHandler: requireLogin }, async (request, reply) =>
    sendOk(reply, await service.listOwner(request.currentUser!, parseIntParam(request.params.id))));
   app.post<{ Params: { id: string } }>('/projects/:id/webgl-network-requests', {
    preHandler: requireLogin, config: { rateLimit: { max: 10, timeWindow: 60_000 } },
   }, async (request, reply) => sendCreated(reply, await service.create(request.currentUser!, parseIntParam(request.params.id), request.body)));
  } else {
   const guard = requireRole('ADMIN', 'OPERATOR');
   app.get('/webgl-network-requests', { preHandler: guard }, async (request, reply) => sendOk(reply, await service.listAdmin(request.currentUser!)));
   for (const action of ['approve', 'reject', 'revoke'] as const) {
    app.post<{ Params: { id: string } }>(`/webgl-network-requests/:id/${action}`, { preHandler: guard }, async (request, reply) =>
     sendOk(reply, await service.review(request.currentUser!, request.params.id, action, request.body)));
   }
  }
 };
}
