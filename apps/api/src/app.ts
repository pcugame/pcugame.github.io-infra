import Fastify from 'fastify';
import type { FastifyError } from 'fastify';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { registerCors } from './plugins/cors.js';
import { registerCookie } from './plugins/cookie.js';
import { registerMultipart } from './plugins/multipart.js';
import { registerAuth } from './plugins/auth.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { publicRoutes } from './modules/public/public.routes.js';
import { adminRoutes } from './modules/admin/admin.routes.js';
import { assetsRoutes } from './modules/assets/assets.routes.js';
import { AppError } from './shared/errors.js';
import type { ApiError } from './shared/http.js';

export async function buildApp() {
  const app = Fastify({
    logger: false,
    bodyLimit: 2 * 1024 * 1024, // 2 MB for JSON bodies
  });

  // Plugins
  await registerCors(app);
  await registerCookie(app);
  await registerMultipart(app);
  await registerAuth(app);

  // Health check
  app.get('/api/health', async (_req, reply) => {
    reply.send({ ok: true, timestamp: new Date().toISOString() });
  });

  // Routes
  await app.register(authRoutes, { prefix: '/api' });
  await app.register(publicRoutes, { prefix: '/api/public' });
  await app.register(adminRoutes, { prefix: '/api/admin' });
  await app.register(assetsRoutes, { prefix: '/api' });

  // Global error handler
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error instanceof AppError) {
      const body: ApiError = {
        ok: false,
        error: {
          code: error.code ?? 'ERROR',
          message: error.message,
        },
      };
      reply.status(error.statusCode).send(body);
      return;
    }

    // Fastify validation errors
    if (error.validation) {
      const body: ApiError = {
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          details: error.validation,
        },
      };
      reply.status(400).send(body);
      return;
    }

    // Multipart file size limit
    if (error.statusCode === 413 || error.code === 'FST_REQ_FILE_TOO_LARGE') {
      const body: ApiError = {
        ok: false,
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'File too large' },
      };
      reply.status(413).send(body);
      return;
    }

    logger.error(error, 'Unhandled error');
    const body: ApiError = {
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    };
    reply.status(500).send(body);
  });

  return app;
}
