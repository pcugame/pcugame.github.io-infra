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
import { headObject } from './lib/storage.js';
import { decInFlight, getLifecycleState, incInFlight } from './lib/lifecycle.js';

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

	// In-flight counter so shutdown can wait for active requests to finish.
	// Runs before routing so counter stays accurate even if a plugin hook rejects.
	app.addHook('onRequest', async () => {
		incInFlight();
	});
	app.addHook('onResponse', async () => {
		decInFlight();
	});

	// Plugins
	await registerCors(app);
	await registerCookie(app);
	await registerMultipart(app);
	await registerAuth(app);
	await registerCsrf(app);

	// Health check — DB ping + storage write test. Flips to 503 when the process is draining
	// so the load balancer stops routing new traffic before we start closing connections.
	app.get('/api/health', async (_req, reply) => {
		const state = getLifecycleState();
		if (state === 'draining' || state === 'shutting_down') {
			reply.status(503).send({ ok: false, state, timestamp: new Date().toISOString() });
			return;
		}

		const checks: Record<string, 'ok' | 'fail'> = {};

		// DB connectivity
		try {
			await prisma.$queryRaw`SELECT 1`;
			checks.db = 'ok';
		} catch {
			checks.db = 'fail';
		}

		// S3 connectivity — probe a non-existent key (HeadObject returns null, not error)
		const cfg = env();
		try {
			await headObject(cfg.S3_BUCKET_PUBLIC, '.healthcheck');
			checks.s3 = 'ok';
		} catch {
			checks.s3 = 'fail';
		}

		const ok = Object.values(checks).every((v) => v === 'ok');
		reply.status(ok ? 200 : 503).send({ ok, state, timestamp: new Date().toISOString(), checks });
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

		// Fastify validation errors.
		// Raw `error.validation` leaks schema paths and internal keywords; log it for ops
		// and return a normalized `{ field, code }` shape that clients can still act on.
		if (error.validation) {
			logger().warn({ validation: error.validation }, 'Request validation failed');
			const details = error.validation.map((v) => ({
				field: typeof v.instancePath === 'string' && v.instancePath.length > 0
					? v.instancePath.replace(/^\//, '').replace(/\//g, '.')
					: (v.params && typeof (v.params as Record<string, unknown>).missingProperty === 'string'
						? String((v.params as Record<string, unknown>).missingProperty)
						: ''),
				code: typeof v.keyword === 'string' ? v.keyword : 'invalid',
			}));
			const body: ApiError = {
				ok: false,
				error: {
					code: 'VALIDATION_ERROR',
					message: 'Validation failed',
					details,
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

		logger().error(error, 'Unhandled error');
		const body: ApiError = {
			ok: false,
			error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
		};
		reply.status(500).send(body);
	});

  return app;
}
