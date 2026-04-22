import type { FastifyInstance } from 'fastify';
import fastifyHelmet from '@fastify/helmet';

/**
 * Security-header defaults for a JSON-only API.
 *
 * Scope constraints that shape these directives:
 * - The API never serves HTML or scripts — responses are JSON or 302 redirects to S3.
 * - The web frontend is hosted on a different origin (GitHub Pages), so CORP must allow
 *   cross-origin responses.
 * - `Referrer-Policy: no-referrer` matches what `assets/service.ts` already sets per
 *   request for the presigned-redirect handlers; helmet provides a safe default for
 *   every other route.
 * - Google OAuth scripts are loaded by the **web** app, not the API, so no CSP
 *   allowance for `accounts.google.com` is needed here.
 */
export async function registerHelmet(app: FastifyInstance): Promise<void> {
	await app.register(fastifyHelmet, {
		contentSecurityPolicy: {
			useDefaults: false,
			directives: {
				'default-src': ["'none'"],
				'frame-ancestors': ["'none'"],
				'base-uri': ["'none'"],
				'form-action': ["'none'"],
			},
		},
		crossOriginResourcePolicy: { policy: 'cross-origin' },
		crossOriginOpenerPolicy: { policy: 'same-origin' },
		crossOriginEmbedderPolicy: false,
		referrerPolicy: { policy: 'no-referrer' },
		strictTransportSecurity: {
			maxAge: 31_536_000,
			includeSubDomains: true,
		},
		xContentTypeOptions: true,
		xFrameOptions: { action: 'deny' },
		xDnsPrefetchControl: { allow: false },
		xPermittedCrossDomainPolicies: { permittedPolicies: 'none' },
	});
}
