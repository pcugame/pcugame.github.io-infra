import type { FastifyInstance } from 'fastify';
import type { GoogleAuthResponse } from '@pcu/contracts';
import { env } from '../../config/env.js';
import { AppError, forbidden, unauthorized } from '../../shared/errors.js';
import { sendOk } from '../../shared/http.js';
import { cookieExpiresAt } from '../../shared/session.js';
import { parseBody, DevAuthLoginBody, DevAuthLoginErrorBody } from '../../shared/validation.js';
import * as authService from '../auth/service.js';

/** Register dev/test-only login routes. Never register this in production. */
export async function devAuthController(app: FastifyInstance): Promise<void> {
	const cfg = env();

	app.post('/auth/login', async (request, reply) => {
		const { role } = parseBody(DevAuthLoginBody, request.body);
		const { user, sessionId, expiresAt } = await authService.loginForDevRole(role);

		reply.setCookie(cfg.SESSION_COOKIE_NAME, sessionId, {
			httpOnly: true,
			secure: cfg.COOKIE_SECURE,
			sameSite: cfg.COOKIE_SAME_SITE,
			path: '/',
			expires: cookieExpiresAt({ expiresAt }),
		});

		sendOk<GoogleAuthResponse>(reply, {
			user: {
				id: user.id,
				email: user.email,
				name: user.name,
				role: user.role,
				studentId: user.studentId ?? undefined,
			},
		});
	});

	app.post('/auth/login-error', async (request) => {
		const { scenario } = parseBody(DevAuthLoginErrorBody, request.body);

		switch (scenario) {
			case 'domain-not-allowed':
				throw forbidden('Email domain not allowed', 'EMAIL_DOMAIN_NOT_ALLOWED');
			case 'google-api-unavailable':
				throw new AppError(401, 'Google authentication service is unavailable', 'GOOGLE_API_UNAVAILABLE');
			case 'invalid-google-token':
				throw unauthorized('Invalid Google token');
			case 'missing-google-payload':
				throw unauthorized('Invalid token payload');
			case 'api-server-error':
				throw new AppError(500, 'Simulated API server error', 'INTERNAL_ERROR');
		}
	});
}
