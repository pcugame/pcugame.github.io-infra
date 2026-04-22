import type { FastifyInstance, FastifyRequest } from 'fastify';
import fastifyRateLimit, { type RateLimitPluginOptions } from '@fastify/rate-limit';
import { env } from '../config/env.js';
import type { ApiError } from '../shared/http.js';

/**
 * IP-based request rate-limiter. Applied globally, but two paths are allowlisted:
 *
 * - `/api/health` — monitoring probes should never trip the limiter.
 * - `/api/assets/protected/*` — already covered by the domain-specific download
 *   limiter in `shared/download-rate-limit.ts` (IP ban on 30 hits / 15min). Running
 *   both on the same path would double-count and confuse operators.
 *
 * Per-route buckets (login, submit) layer on top via `config.rateLimit` on the
 * route definition. Fastify merges those with the global bucket, so the stricter
 * one wins.
 *
 * `keyGenerator` uses `request.ip`, which respects the app's `trustProxy` setting,
 * so X-Forwarded-For behaves correctly in reverse-proxied production deployments.
 */
export async function registerRateLimit(app: FastifyInstance): Promise<void> {
	const cfg = env();

	await app.register(fastifyRateLimit, {
		global: true,
		max: cfg.RATE_LIMIT_GLOBAL_MAX,
		timeWindow: cfg.RATE_LIMIT_GLOBAL_WINDOW_MS,
		keyGenerator: (req: FastifyRequest) => req.ip,
		allowList: (req: FastifyRequest) =>
			req.url === '/api/health'
			|| req.url.startsWith('/api/assets/protected/'),
		skipOnError: true,
		// The plugin reads `statusCode` from our returned object to set the HTTP status,
		// then sends the whole object as the JSON body. Including it here lands the
		// client response at 429 with our ApiError envelope; clients ignore the stray
		// `statusCode` body field (the HTTP status is already present on the response).
		errorResponseBuilder: ((_req, context) => {
			const body: ApiError & { statusCode: number } = {
				statusCode: 429,
				ok: false,
				error: {
					code: 'RATE_LIMITED',
					message: `Too many requests. Retry after ${Math.ceil(context.ttl / 1000)}s.`,
				},
			};
			return body;
		}) as NonNullable<RateLimitPluginOptions['errorResponseBuilder']>,
	});
}
