import type { FastifyPluginAsync } from 'fastify';
import type { GoogleAuthResponse, LogoutResponse, MeResponse } from '@pcu/contracts';
import type { Clock } from '../../application/ports.js';
import { sendOk } from '../../shared/http.js';
import { parseBody, GoogleLoginBody } from '../../shared/validation.js';
import { cookieExpiresAt } from '../../shared/session.js';
import type { AuthService } from './service.js';

export interface AuthControllerDeps {
	config: {
		RATE_LIMIT_LOGIN_MAX: number;
		RATE_LIMIT_LOGIN_WINDOW_MS: number;
		SESSION_COOKIE_NAME: string;
		COOKIE_SECURE: boolean;
		COOKIE_SAME_SITE: 'strict' | 'lax' | 'none';
		SESSION_IDLE_MS: number;
	};
	clock: Clock;
	service: Pick<AuthService, 'loginWithGoogle' | 'logout'>;
}

/** Register authentication routes (Google OAuth, logout, /me) */
export function createAuthController(deps: AuthControllerDeps): FastifyPluginAsync {
	const cfg = deps.config;
	return async function authController(app): Promise<void> {
		/** POST /api/auth/google — Google One-Tap / OAuth login */
		const loginRouteConfig: Record<string, unknown> = {
			rateLimit: {
				max: cfg.RATE_LIMIT_LOGIN_MAX,
				timeWindow: cfg.RATE_LIMIT_LOGIN_WINDOW_MS,
			},
		};
		app.post('/auth/google', { config: loginRouteConfig }, async (request, reply) => {
			const { credential } = parseBody(GoogleLoginBody, request.body);
			const { user, sessionId, expiresAt } = await deps.service.loginWithGoogle(credential);

			reply.setCookie(cfg.SESSION_COOKIE_NAME, sessionId, {
				httpOnly: true,
				secure: cfg.COOKIE_SECURE,
				sameSite: cfg.COOKIE_SAME_SITE,
				path: '/',
				expires: cookieExpiresAt({ expiresAt }, deps.clock.now(), cfg.SESSION_IDLE_MS),
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

		/** POST /api/auth/logout — clear session */
		app.post('/auth/logout', async (request, reply) => {
			if (request.currentUser) {
				const sid = request.cookies[cfg.SESSION_COOKIE_NAME];
				await deps.service.logout(sid);
			}

			reply.clearCookie(cfg.SESSION_COOKIE_NAME, {
				path: '/',
				secure: cfg.COOKIE_SECURE,
				sameSite: cfg.COOKIE_SAME_SITE,
			});
			sendOk<LogoutResponse>(reply, { message: 'Logged out' });
		});

		/** GET /api/me — current user info (no auth required) */
		app.get('/me', async (request, reply) => {
			if (!request.currentUser) {
				sendOk<MeResponse>(reply, { authenticated: false });
				return;
			}
			sendOk<MeResponse>(reply, {
				authenticated: true,
				user: {
					id: request.currentUser.id,
					email: request.currentUser.email,
					name: request.currentUser.name,
					role: request.currentUser.role,
					studentId: request.currentUser.studentId,
				},
			});
		});
	};
}
