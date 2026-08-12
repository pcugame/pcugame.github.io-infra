import type { FastifyInstance } from 'fastify';
import fastifyHelmet from '@fastify/helmet';

/**
 * Security-header defaults for an API that serves JSON, redirects, and bytes.
 *
 * Scope constraints that shape these directives:
 * - Public images and WebGL assets may be streamed, but the API never renders
 *   executable application HTML of its own.
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
