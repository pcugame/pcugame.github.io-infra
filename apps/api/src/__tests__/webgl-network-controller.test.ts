import Fastify from 'fastify';
import { registerRateLimit } from '../plugins/rate-limit.js';
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod';
import { expect, it, vi } from 'vitest';
import { WebglNetworkBatchResponseSchema, type WebglNetworkRequest } from '@pcu/contracts';
import { createWebglNetworkController } from '../modules/webgl-network/controller.js';
import { createWebglNetworkService } from '../modules/webgl-network/service.js';
import { createUnavailableWebglNetworkRepository } from '../modules/webgl-network/repository.js';
import { registerRouteSchemas } from '../shared/http-route-schemas.js';
import { defaultTestEnv } from './helpers/app-mocks.js';

it('counts a sixteen-item batch as one of ten allowed HTTP requests per minute', async () => {
 const config = { ...defaultTestEnv, LOG_LEVEL: 'info' as const, GOOGLE_CLIENT_IDS: [...defaultTestEnv.GOOGLE_CLIENT_IDS], CORS_ALLOWED_ORIGINS: [...defaultTestEnv.CORS_ALLOWED_ORIGINS], WEBGL_EXTERNAL_CONNECTIONS_ENABLED: true };
 const app = Fastify();
 app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler); registerRouteSchemas(app);
 await registerRateLimit(app, config);
 app.addHook('onRequest', async request => { request.currentUser = { id: 1, googleSub: 'fixture', email: 'fixture@example.com', name: 'Fixture', role: 'USER' }; });
 const items = Array.from({ length: 16 }, (_, index): WebglNetworkRequest => ({
  id: crypto.randomUUID(), origin: `https://host${index}.example.com`, mode: 'HTTPS', purpose: 'Bundles', cors: 'Configured',
  projectId: 1, originalProjectId: 1, projectTitle: 'Fixture', requesterId: 1, state: 'PENDING', reviewerId: null,
  reviewReason: null, createdAt: new Date().toISOString(), reviewedAt: null, revokedAt: null, policyVersion: null, events: [],
 }));
 const createBatch = vi.fn().mockResolvedValue(items);
 const service = createWebglNetworkService({ ...createUnavailableWebglNetworkRepository(), createBatch }, config);
 await app.register(createWebglNetworkController(service, 'me'), { prefix: '/api/me' });
 const payload = { items: items.map(({ origin, mode, purpose, cors }) => ({ origin, mode, purpose, cors })) };
 try {
  for (let index = 0; index < 10; index++) {
   const response = await app.inject({ method: 'POST', url: '/api/me/projects/1/webgl-network-requests/batch', payload });
   expect(response.statusCode, response.body).toBe(201);
   expect(WebglNetworkBatchResponseSchema.parse(response.json().data).items).toHaveLength(16);
  }
  const limited = await app.inject({ method: 'POST', url: '/api/me/projects/1/webgl-network-requests/batch', payload });
  expect(limited.statusCode).toBe(429); expect(createBatch).toHaveBeenCalledTimes(10);
 } finally { await app.close(); }
});
