import type { FastifyInstance, FastifyRequest } from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import type { Env } from '../config/env.js';
import type { ApiError } from '../shared/http.js';

export const GLOBAL_IP_ABUSE_CEILING_MIN = 5_000;
export const DIRECT_CONTROL_ACTOR_MAX = 600;
export const DIRECT_CONTROL_SESSION_MAX = 240;

type Window = { startedAtMs: number; count: number };

/**
 * Authenticated control-plane limiter. The primary bucket is the actor, not
 * the school/lab NAT address. Session-scoped status, URL refresh, completion,
 * and cancellation also receive a narrower secondary bucket.
 */
export class DirectControlPrincipalLimiter {
	private readonly windows = new Map<string, Window>();

	constructor(
		private readonly windowMs = 60_000,
		private readonly actorMax = DIRECT_CONTROL_ACTOR_MAX,
		private readonly sessionMax = DIRECT_CONTROL_SESSION_MAX,
		private readonly now = () => Date.now(),
	) {}

	check(actorId: number, sessionId?: string): { allowed: true } | { allowed: false; retryAfterSec: number } {
		const now = this.now();
		const keys: Array<[string, number]> = [[`actor:${actorId}`, this.actorMax]];
		if (sessionId) keys.push([`actor:${actorId}:session:${sessionId}`, this.sessionMax]);
		for (const [key, max] of keys) {
			const current = this.windows.get(key);
			if (current && now - current.startedAtMs < this.windowMs && current.count >= max) {
				return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((current.startedAtMs + this.windowMs - now) / 1000)) };
			}
		}
		for (const [key] of keys) {
			const current = this.windows.get(key);
			if (!current || now - current.startedAtMs >= this.windowMs) this.windows.set(key, { startedAtMs: now, count: 1 });
			else current.count += 1;
		}
		if (this.windows.size > 10_000) {
			for (const [key, value] of this.windows) {
				if (now - value.startedAtMs >= this.windowMs) this.windows.delete(key);
			}
		}
		return { allowed: true };
	}
}

export function globalIpAbuseCeiling(configured: number): number {
	return Math.max(configured, GLOBAL_IP_ABUSE_CEILING_MIN);
}

/**
 * The controller is mounted below `/api/admin` in production.  Keep the
 * optional non-admin prefix for isolated controller tests, but never infer a
 * session bucket from an arbitrary URL.
 */
export function directUploadSessionId(url: string): string | undefined {
	const path = url.split('?', 1)[0] ?? url;
	const match = path.match(/^\/api\/(?:admin\/)?direct-asset-upload-sessions\/([^/]+)(?:\/|$)/);
	return match?.[1];
}

export function isDirectUploadControl(url: string): boolean {
	const path = url.split('?', 1)[0] ?? url;
	return /^\/api\/(?:admin\/)?(?:projects|exhibitions)\/[^/]+\/direct-(game|webgl|video|image|poster)-upload-sessions$/.test(path)
		|| /^\/api\/(?:admin\/)?direct-asset-upload-sessions\/[^/]+(?:\/(?:part-urls|complete))?$/.test(path);
}

/** Canonical asset capability route; excludes the removed storage-key bridge. */
export function isCanonicalAssetDownload(url: string): boolean {
	const path = url.split('?', 1)[0] ?? url;
	return /^\/api\/assets\/[1-9]\d*\/download$/.test(path);
}

/**
 * IP-based request rate-limiter. Applied globally, but two classes of paths are
 * allowlisted:
 *
 * - `/api/health` and `/api/health/deep` — monitoring probes should never trip
 *   the limiter, and the LB polls the shallow one on a short interval.
 * - `/api/assets/:assetId/download` — covered by the domain-specific protected download
 *   limiter after asset lookup/access checks. Running both on the same path would
 *   double-count and confuse operators.
 *
 * Per-route buckets (login, submit) layer on top via `config.rateLimit` on the
 * route definition. Fastify merges those with the global bucket, so the stricter
 * one wins.
 *
 * `keyGenerator` uses `request.ip`, which respects the app's `trustProxy` setting,
 * so X-Forwarded-For behaves correctly in reverse-proxied production deployments.
 */
export async function registerRateLimit(app: FastifyInstance, cfg: Env): Promise<void> {
	const directControl = new DirectControlPrincipalLimiter();
	await app.register(fastifyRateLimit, {
		global: true,
		// This is an unauthenticated/IP abuse ceiling, not the normal user quota.
		// Authenticated direct-upload controls are limited by actor/session below.
		max: globalIpAbuseCeiling(cfg.RATE_LIMIT_GLOBAL_MAX),
		timeWindow: cfg.RATE_LIMIT_GLOBAL_WINDOW_MS,
		keyGenerator: (req: FastifyRequest) => req.ip,
		allowList: (req: FastifyRequest) =>
			req.url === '/api/health'
			|| req.url === '/api/health/deep'
			|| isCanonicalAssetDownload(req.url),
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
		}),
	});

	app.addHook('preHandler', async (request, reply) => {
		if (!isDirectUploadControl(request.url) || !request.currentUser) return;
		const result = directControl.check(request.currentUser.id, directUploadSessionId(request.url));
		if (result.allowed) return;
		reply.header('retry-after', String(result.retryAfterSec));
		reply.status(429).send({
			ok: false,
			error: { code: 'RATE_LIMITED', message: `Too many upload control requests. Retry after ${result.retryAfterSec}s.` },
		} satisfies ApiError);
	});
}
