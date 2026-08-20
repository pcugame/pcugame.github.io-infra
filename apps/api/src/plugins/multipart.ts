import type { FastifyInstance } from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import type { Env } from '../config/env.js';

export async function registerMultipart(app: FastifyInstance, cfg: Env): Promise<void> {
  // Multipart is an inline-only ingress boundary. Large assets use direct
  // browser-to-storage capabilities and never enter Fastify.
  const globalMaxBytes = cfg.INLINE_UPLOAD_MAX_BYTES ?? 16 * 1024 * 1024;

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: globalMaxBytes,
      files: cfg.UPLOAD_PRIVILEGED_MAX_FILES,
      fields: 32,
      parts: cfg.UPLOAD_PRIVILEGED_MAX_FILES + 32,
      headerPairs: 32,
    },
    attachFieldsToBody: false,
  });
}
