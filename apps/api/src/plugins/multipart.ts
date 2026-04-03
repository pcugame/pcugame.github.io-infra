import type { FastifyInstance } from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import { env } from '../config/env.js';

export async function registerMultipart(app: FastifyInstance): Promise<void> {
  const cfg = env();
  // Global ceiling = privileged game max (the absolute largest single file
  // any user can upload).  Per-file and per-request role-based limits are
  // enforced in the route handlers via streaming byte limiters.
  const globalMaxBytes = cfg.UPLOAD_PRIVILEGED_GAME_MAX_MB * 1024 * 1024;

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: globalMaxBytes,
      files: cfg.UPLOAD_PRIVILEGED_MAX_FILES,
    },
    attachFieldsToBody: false,
  });
}
