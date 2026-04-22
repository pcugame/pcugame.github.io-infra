import type { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';
import { forbidden } from '../shared/errors.js';

/**
 * Pure origin-validation logic — no Fastify dependency, fully testable.
 *
 * Policy:
 * - GET / HEAD / OPTIONS are always allowed (read-only).
 * - For state-changing methods (POST, PATCH, DELETE, PUT) the `Origin` header
 *   must be present and match an allowed origin. Browsers always send `Origin`
 *   on credentialed cross-origin state-changing fetches, so a missing header
 *   is treated as untrusted. `Referer` is intentionally not consulted — it can
 *   be stripped by privacy tooling and is weaker evidence than `Origin`.
 */
export function validateCsrfOrigin(
	method: string,
	originHeader: string | undefined,
	allowedOrigins: ReadonlySet<string>,
): void {
	const upper = method.toUpperCase();
	if (upper === 'GET' || upper === 'HEAD' || upper === 'OPTIONS') return;

	if (!originHeader) {
		throw forbidden('CSRF check failed: missing origin header');
	}
	if (!allowedOrigins.has(originHeader)) {
		throw forbidden(`CSRF check failed: origin '${originHeader}' is not allowed`);
	}
}

/**
 * Fastify plugin that enforces CSRF origin validation on all
 * state-changing requests (POST, PATCH, DELETE, PUT).
 */
export async function registerCsrf(app: FastifyInstance): Promise<void> {
	const allowedOrigins = new Set(env().CORS_ALLOWED_ORIGINS);

	app.addHook('onRequest', async (request) => {
		validateCsrfOrigin(request.method, request.headers.origin, allowedOrigins);
	});
}
