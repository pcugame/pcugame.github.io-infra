import type { FastifyPluginAsync } from 'fastify';
import { AwardEditSchema, AwardVersionSchema, AwardOrderSchema, AwardRecipientsSchema } from '@pcu/contracts';
import { requireRole } from '../../plugins/auth.js';
import { sendOk } from '../../shared/http.js';
import type { createAwardService } from './service.js';
export function createAwardController(service: ReturnType<typeof createAwardService>): FastifyPluginAsync {
 return async app => {
  app.addHook('preHandler', requireRole('ADMIN', 'OPERATOR'));
  app.addHook('onSend', async (_r, reply) => { reply.header('Cache-Control', 'private, no-store'); });
  app.get<{ Params: { id: string } }>('/exhibitions/:id/awards', async (r, reply) => sendOk(reply, await service.read(Number(r.params.id))));
  app.post<{ Params: { id: string } }>('/exhibitions/:id/awards', async (r, reply) => {
   const { expectedVersion, ...data } = AwardEditSchema.parse(r.body);
   sendOk(reply, await service.change(Number(r.params.id), expectedVersion, { kind: 'create', ...data }));
  });
  app.patch<{ Params: { id: string; awardId: string } }>('/exhibitions/:id/awards/:awardId', async (r, reply) => {
   const { expectedVersion, ...data } = AwardEditSchema.parse(r.body);
   sendOk(reply, await service.change(Number(r.params.id), expectedVersion, { kind: 'edit', awardId: Number(r.params.awardId), ...data }));
  });
  app.delete<{ Params: { id: string; awardId: string } }>('/exhibitions/:id/awards/:awardId', async (r, reply) => {
   sendOk(reply, await service.change(Number(r.params.id), AwardVersionSchema.parse(r.body).expectedVersion, { kind: 'delete', awardId: Number(r.params.awardId) }));
  });
  app.put<{ Params: { id: string } }>('/exhibitions/:id/awards/order', async (r, reply) => {
   const { expectedVersion, awardIds } = AwardOrderSchema.parse(r.body);
   sendOk(reply, await service.change(Number(r.params.id), expectedVersion, { kind: 'order', awardIds }));
  });
  app.patch<{ Params: { id: string; awardId: string } }>('/exhibitions/:id/awards/:awardId/recipients', async (r, reply) => {
   const { expectedVersion, ...data } = AwardRecipientsSchema.parse(r.body);
   sendOk(reply, await service.change(Number(r.params.id), expectedVersion, { kind: 'recipients', awardId: Number(r.params.awardId), ...data }));
  });
  app.put<{ Params: { id: string } }>('/projects/:id/awards', async (r, reply) => {
   const { expectedVersion, awardIds } = AwardOrderSchema.parse(r.body);
   sendOk(reply, await service.change(null, expectedVersion, { kind: 'project', projectId: Number(r.params.id), awardIds }));
  });
  app.delete<{ Params: { id: string; assetId: string } }>('/exhibitions/:id/award-images/:assetId', async (r, reply) => {
   sendOk(reply, await service.change(Number(r.params.id), AwardVersionSchema.parse(r.body).expectedVersion, { kind: 'asset-delete', assetId: Number(r.params.assetId) }));
  });
 };
}
