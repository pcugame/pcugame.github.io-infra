import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyError } from 'fastify';
import { env } from './config/env.js';
import { logger, rootLogger } from './lib/logger.js';
import { requestContext } from './lib/request-context.js';
import { registerHelmet } from './plugins/helmet.js';
import { registerRateLimit } from './plugins/rate-limit.js';
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
		// Fixed-width UUIDs beat the default monotonically-increasing string for
		// log correlation across multiple instances behind a load balancer.
		genReqId: () => randomUUID(),
	});

	// In-flight counter so shutdown can wait for active requests to finish.
	// Runs before routing so counter stays accurate even if a plugin hook rejects.
	app.addHook('onRequest', async () => {
		incInFlight();
	});
	app.addHook('onResponse', async () => {
		decInFlight();
	});

	// Seed the AsyncLocalStorage request context. `enterWith` mutates the current
	// async scope so every downstream `await` (plugins, handlers, services, repos)
	// sees the same child logger. Also echo the request id on the response so
	// clients/ops can cross-reference a failing request with server logs.
	app.addHook('onRequest', async (request, reply) => {
		const log = rootLogger().child({ reqId: request.id });
		requestContext.enterWith({ reqId: request.id, log });
		reply.header('x-request-id', request.id);
	});

	// Plugins
	await registerHelmet(app);
	await registerRateLimit(app);
	await registerCors(app);
	await registerCookie(app);
	await registerMultipart(app);
	await registerAuth(app);
	await registerCsrf(app);

	// Shallow health — DB + lifecycle only. This is what the LB / Docker HEALTHCHECK
	// consults, so an S3 (Garage) outage must NOT flip the container to unhealthy:
	// most routes don't touch S3, and removing the API from rotation just because
	// object storage blipped would be worse than serving those routes degraded.
	// 503 when draining/shutting_down so the LB stops routing new traffic.
	app.get('/api/health', async (_req, reply) => {
		const state = getLifecycleState();
		if (state === 'draining' || state === 'shutting_down') {
			reply.status(503).send({ ok: false, state, timestamp: new Date().toISOString() });
			return;
		}

		const checks: Record<string, 'ok' | 'fail'> = {};
		try {
			await prisma.$queryRaw`SELECT 1`;
			checks.db = 'ok';
		} catch {
			checks.db = 'fail';
		}

		const ok = checks.db === 'ok';
		reply.status(ok ? 200 : 503).send({ ok, state, timestamp: new Date().toISOString(), checks });
	});

	// Deep health — DB + S3 probe. For monitoring dashboards / ops that want the full
	// picture. Not wired to the LB so S3 alone can't take the API out of rotation.
	app.get('/api/health/deep', async (_req, reply) => {
		const state = getLifecycleState();
		if (state === 'draining' || state === 'shutting_down') {
			reply.status(503).send({ ok: false, state, timestamp: new Date().toISOString() });
			return;
		}

		const checks: Record<string, 'ok' | 'fail'> = {};

		try {
			await prisma.$queryRaw`SELECT 1`;
			checks.db = 'ok';
		} catch {
			checks.db = 'fail';
		}

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

		// Rate-limit plugin throws an error with statusCode 429; its onExceeding/onExceeded
		// hooks already set `x-ratelimit-*` + `retry-after` headers. The message carries the
		// per-route retry window. Normalize to the project's ApiError envelope here so clients
		// don't need to special-case the raw fastify error shape.
		if (error.statusCode === 429) {
			const body: ApiError = {
				ok: false,
				error: {
					code: 'RATE_LIMITED',
					message: error.message || 'Too many requests',
				},
			};
			reply.status(429).send(body);
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
