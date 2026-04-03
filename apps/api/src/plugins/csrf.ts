import type { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';
import { forbidden } from '../shared/errors.js';

/**
 * Pure origin-validation logic — no Fastify dependency, fully testable.
 *
 * Returns `true` if the request should be allowed, throws on denial.
 *
 * Policy:
 * - GET / HEAD / OPTIONS are always allowed (read-only).
 * - For state-changing methods (POST, PATCH, DELETE, PUT):
 *   - If `Origin` header is present, it must match an allowed origin.
 *   - Otherwise fall back to `Referer` header's origin.
 *   - If neither is present, reject — legitimate browser cross-origin
 *     requests always include `Origin`.
 */
export function validateCsrfOrigin(
	method: string,
	originHeader: string | undefined,
	refererHeader: string | undefined,
	allowedOrigins: ReadonlySet<string>,
): void {
	const upper = method.toUpperCase();
	if (upper === 'GET' || upper === 'HEAD' || upper === 'OPTIONS') return;

	// Primary: Origin header
	if (originHeader) {
		if (allowedOrigins.has(originHeader)) return;
		throw forbidden(`CSRF check failed: origin '${originHeader}' is not allowed`);
	}

	// Fallback: Referer header
	if (refererHeader) {
		try {
			const refOrigin = new URL(refererHeader).origin;
			if (allowedOrigins.has(refOrigin)) return;
		} catch {
			// malformed Referer — fall through to rejection
		}
		throw forbidden('CSRF check failed: referer origin is not allowed');
	}

	// No Origin, no Referer — reject
	throw forbidden('CSRF check failed: missing origin header');
}

/**
 * Fastify plugin that enforces CSRF origin validation on all
 * state-changing requests (POST, PATCH, DELETE, PUT).
 */
export async function registerCsrf(app: FastifyInstance): Promise<void> {
	const allowedOrigins = new Set(env().CORS_ALLOWED_ORIGINS);

	app.addHook('onRequest', async (request) => {
		validateCsrfOrigin(
			request.method,
			request.headers.origin,
			request.headers.referer,
			allowedOrigins,
		);
	});
}
