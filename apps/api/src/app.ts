import Fastify from 'fastify';
import type { FastifyError } from 'fastify';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { registerCors } from './plugins/cors.js';
import { registerCookie } from './plugins/cookie.js';
import { registerMultipart } from './plugins/multipart.js';
import { registerAuth } from './plugins/auth.js';
import { registerCsrf } from './plugins/csrf.js';
import { authController } from './modules/auth/index.js';
import { publicController } from './modules/public/index.js';
import { adminRoutes } from './modules/admin/admin.routes.js';
import { assetsController } from './modules/assets/index.js';
import { AppError } from './shared/errors.js';
import type { ApiError } from './shared/http.js';
import { prisma } from './lib/prisma.js';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

function parseTrustProxy(val: string): boolean | number | string {
	if (val === 'true') return true;
	if (val === 'false' || val === '') return false;
	const num = Number(val);
	if (!isNaN(num) && Number.isInteger(num) && num > 0) return num;
	return val; // comma-separated IPs or subnet
}

export async function buildApp() {
	const cfg = env();
	const app = Fastify({
		logger: false,
		bodyLimit: 2 * 1024 * 1024, // 2 MB for JSON bodies
		trustProxy: parseTrustProxy(cfg.TRUST_PROXY),
	});

	// Plugins
	await registerCors(app);
	await registerCookie(app);
	await registerMultipart(app);
	await registerAuth(app);
	await registerCsrf(app);

	// Health check — DB ping + storage write test
	app.get('/api/health', async (_req, reply) => {
		const checks: Record<string, 'ok' | 'fail'> = {};

		// DB connectivity
		try {
			await prisma.$queryRaw`SELECT 1`;
			checks.db = 'ok';
		} catch {
			checks.db = 'fail';
		}

		// Storage directories writable
		const cfg = env();
		for (const dir of [cfg.UPLOAD_ROOT_PUBLIC, cfg.UPLOAD_ROOT_PROTECTED]) {
			const probe = path.join(dir, `.healthcheck-${process.pid}`);
			try {
				await fsp.writeFile(probe, '');
				await fsp.unlink(probe);
				checks[`storage:${path.basename(dir)}`] = 'ok';
			} catch {
				checks[`storage:${path.basename(dir)}`] = 'fail';
			}
		}

		const ok = Object.values(checks).every((v) => v === 'ok');
		reply.status(ok ? 200 : 503).send({ ok, timestamp: new Date().toISOString(), checks });
	});

	// Routes
	await app.register(authController, { prefix: '/api' });
	await app.register(publicController, { prefix: '/api/public' });
	await app.register(adminRoutes, { prefix: '/api/admin' });
	await app.register(assetsController, { prefix: '/api' });

	// Global error handler
	app.setErrorHandler((error: FastifyError, _request, reply) => {
		if (error instanceof AppError) {
			const body: ApiError = {
				ok: false,
				error: {
					code: error.code ?? 'ERROR',
					message: error.message,
					...(error.details !== undefined ? { details: error.details } : {}),
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
