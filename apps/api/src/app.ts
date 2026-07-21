import Fastify from 'fastify';
import type { FastifyError, FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod';
import { requestContext } from './lib/request-context.js';
import { registerHelmet } from './plugins/helmet.js';
import { registerRateLimit } from './plugins/rate-limit.js';
import { registerCors } from './plugins/cors.js';
import { registerCookie } from './plugins/cookie.js';
import { registerMultipart } from './plugins/multipart.js';
import { registerAuth } from './plugins/auth.js';
import { registerCsrf } from './plugins/csrf.js';
import { AppError } from './shared/errors.js';
import type { ApiError } from './shared/http.js';
import type { BackendContext } from './backend-context.js';
import { registerRouteSchemas } from './shared/http-route-schemas.js';

function parseTrustProxy(val: string): boolean | number | string {
	if (val === 'true') return true;
	if (val === 'false' || val === '') return false;
	const num = Number(val);
	if (!isNaN(num) && Number.isInteger(num) && num > 0) return num;
	return val; // comma-separated IPs or subnet
}

export function shouldRegisterDevAuth(cfg: { DEV_AUTH_ENABLED: boolean; NODE_ENV: string }): boolean {
	return cfg.DEV_AUTH_ENABLED && cfg.NODE_ENV !== 'production';
}

function registerGlobalErrorHandler(app: FastifyInstance, appLogger: BackendContext['logger']): void {
	app.setErrorHandler((error: FastifyError, _request, reply) => {
		if (error instanceof AppError) {
			// Some AppErrors carry a backoff hint in `details.retryAfterSec` (e.g. the
			// upload-semaphore 429). Promote it to a real `Retry-After` header so clients
			// and intermediaries don't have to parse the JSON body to know when to retry.
			if (
				error.statusCode === 429
				&& error.details
				&& typeof error.details === 'object'
				&& 'retryAfterSec' in (error.details as Record<string, unknown>)
			) {
				const hint = (error.details as { retryAfterSec?: unknown }).retryAfterSec;
				if (typeof hint === 'number' && hint > 0) {
					reply.header('Retry-After', String(Math.ceil(hint)));
				}
			}
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
			appLogger.warn({ validation: error.validation }, 'Request validation failed');
			const details = error.validation.map((v) => ({
				field: typeof v.instancePath === 'string' && v.instancePath.length > 0
					? v.instancePath.replace(/^\//, '').replace(/\//g, '.')
					: (v.params && typeof (v.params).missingProperty === 'string'
						? String((v.params).missingProperty)
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

		appLogger.error(error, 'Unhandled error');
		const body: ApiError = {
			ok: false,
			error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
		};
		reply.status(500).send(body);
	});
}

export interface BuildAppOptions {
	context?: BackendContext;
}

export async function buildApp(options: BuildAppOptions = {}) {
	// Keep production wiring out of tests that supply a fake context. Besides
	// reducing import-time side effects, this makes the composition seam real:
	// no Prisma/S3/OAuth adapter is loaded unless the production default is used.
	const context = options.context ?? (await import('./backend-context.js'))
		.createProductionBackendContext();
	const cfg = context.config;
	const app = Fastify({
		logger: false,
		bodyLimit: 2 * 1024 * 1024, // 2 MB for JSON bodies
		trustProxy: parseTrustProxy(cfg.TRUST_PROXY),
		// Fixed-width UUIDs beat the default monotonically-increasing string for
		// log correlation across multiple instances behind a load balancer.
		genReqId: () => context.ids.next(),
	});

	// Route schemas use the shared Zod contracts. Compilers are installed once at
	// the HTTP composition boundary instead of being hidden in feature modules.
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(serializerCompiler);
	registerRouteSchemas(app);

	// In-flight counter so shutdown can wait for active requests to finish.
	// Runs before routing so counter stays accurate even if a plugin hook rejects.
	app.addHook('onRequest', async () => {
		context.lifecycle.requestStarted();
	});
	app.addHook('onResponse', async () => {
		context.lifecycle.requestFinished();
	});
	app.addHook('onClose', async () => {
		let firstError: unknown;
		for (const resource of [...context.shutdownResources].reverse()) {
			try {
				await resource.close();
			} catch (error) {
				firstError ??= error;
			}
		}
		if (firstError !== undefined) throw firstError;
	});

	// Seed the AsyncLocalStorage request context. `enterWith` mutates the current
	// async scope so every downstream `await` (plugins, handlers, services, repos)
	// sees the same child logger. Also echo the request id on the response so
	// clients/ops can cross-reference a failing request with server logs.
	app.addHook('onRequest', async (request, reply) => {
		const log = context.logger.child({ reqId: request.id });
		requestContext.enterWith({ reqId: request.id, log });
		reply.header('x-request-id', request.id);
	});

	// Plugins
	await registerHelmet(app);
	await registerRateLimit(app, cfg);
	await registerCors(app, cfg);
	await registerCookie(app, cfg);
	await registerMultipart(app, cfg);
	await registerAuth(app, {
		config: cfg,
		clock: context.clock,
		sessions: context.authSessions,
		logger: context.logger,
	});
	await registerCsrf(app, cfg);
	registerGlobalErrorHandler(app, context.logger);

	// Shallow health — DB + lifecycle only. This is what the LB / Docker HEALTHCHECK
	// consults, so an S3 (Garage) outage must NOT flip the container to unhealthy:
	// most routes don't touch S3, and removing the API from rotation just because
	// object storage blipped would be worse than serving those routes degraded.
	// 503 when draining/shutting_down so the LB stops routing new traffic.
	app.get('/api/health', async (_req, reply) => {
		const state = context.lifecycle.state();
		if (state === 'draining' || state === 'shutting_down') {
			reply.status(503).send({ ok: false, state, timestamp: context.clock.now().toISOString() });
			return;
		}

		const checks: Record<string, 'ok' | 'fail'> = {};
		checks.db = await context.databaseHealth.check() ? 'ok' : 'fail';

		const ok = checks.db === 'ok';
		reply.status(ok ? 200 : 503).send({ ok, state, timestamp: context.clock.now().toISOString(), checks });
	});

	// Deep health — DB + storage probe for upload/image/export diagnostics.
	// It intentionally includes S3 and keeps the checks.s3 wire shape stable.
	// Not wired to the LB so S3 alone can't take the API out of rotation.
	app.get('/api/health/deep', async (_req, reply) => {
		const state = context.lifecycle.state();
		if (state === 'draining' || state === 'shutting_down') {
			reply.status(503).send({ ok: false, state, timestamp: context.clock.now().toISOString() });
			return;
		}

		const checks: Record<string, 'ok' | 'fail'> = {};

		checks.db = await context.databaseHealth.check() ? 'ok' : 'fail';

		try {
			await context.storage.head(cfg.S3_BUCKET_PUBLIC, '.healthcheck');
			checks.s3 = 'ok';
		} catch {
			checks.s3 = 'fail';
		}

		const ok = Object.values(checks).every((v) => v === 'ok');
		reply.status(ok ? 200 : 503).send({ ok, state, timestamp: context.clock.now().toISOString(), checks });
	});

	// Routes
	await app.register(context.routes.auth, { prefix: '/api' });
	if (shouldRegisterDevAuth(cfg)) {
		await app.register(context.routes.devAuth, { prefix: '/api/dev' });
	}
	await app.register(context.routes.public, { prefix: '/api/public' });
	await app.register(context.routes.me, { prefix: '/api/me' });
	await app.register(context.routes.admin, { prefix: '/api/admin' });
	await app.register(context.routes.assets, { prefix: '/api' });

	return app;
}
