import type { FastifyInstance } from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import { SIZE_LIMITS } from '../shared/file-signature.js';

export async function registerMultipart(app: FastifyInstance): Promise<void> {
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: SIZE_LIMITS.totalMultipart,
      files: 20,
    },
    attachFieldsToBody: false,
  });
}
