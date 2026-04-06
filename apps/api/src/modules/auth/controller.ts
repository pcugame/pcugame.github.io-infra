import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env.js';
import { sendOk } from '../../shared/http.js';
import { parseBody, GoogleLoginBody } from '../../shared/validation.js';
import * as authService from './service.js';

/** Register authentication routes (Google OAuth, logout, /me) */
export async function authController(app: FastifyInstance): Promise<void> {
	const cfg = env();

	/** POST /api/auth/google — Google One-Tap / OAuth login */
	app.post('/auth/google', async (request, reply) => {
		const { credential } = parseBody(GoogleLoginBody, request.body);
		const { user, sessionId, expiresAt } = await authService.loginWithGoogle(credential);

		reply.setCookie(cfg.SESSION_COOKIE_NAME, sessionId, {
			httpOnly: true,
			secure: cfg.COOKIE_SECURE,
			sameSite: cfg.COOKIE_SAME_SITE,
			path: '/',
			expires: expiresAt,
		});

		sendOk(reply, {
			user: { id: user.id, email: user.email, name: user.name, role: user.role },
		});
	});

	/** POST /api/auth/logout — clear session */
	app.post('/auth/logout', async (request, reply) => {
		if (request.currentUser) {
			const sid = request.cookies[cfg.SESSION_COOKIE_NAME];
			await authService.logout(sid);
		}

		reply.clearCookie(cfg.SESSION_COOKIE_NAME, {
			path: '/',
			secure: cfg.COOKIE_SECURE,
			sameSite: cfg.COOKIE_SAME_SITE,
		});
		sendOk(reply, { message: 'Logged out' });
	});

	/** GET /api/me — current user info (no auth required) */
	app.get('/me', async (request, reply) => {
		if (!request.currentUser) {
			sendOk(reply, { authenticated: false });
			return;
		}
		sendOk(reply, {
			authenticated: true,
			user: {
				id: request.currentUser.id,
				email: request.currentUser.email,
				name: request.currentUser.name,
				role: request.currentUser.role,
			},
		});
	});
}
