import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Env } from '../config/env.js';
import { unauthorized, forbidden } from '../shared/errors.js';
import { cookieExpiresAt, isIdleExpired } from '../shared/session.js';
import { extractStudentIdFromEmail } from '../modules/auth/student-id.js';
import type { UserRole } from '@pcu/contracts';
import { isAllowedSessionSource } from '../shared/session-origin.js';
import type { AppLogger, AuthSessionStore, Clock } from '../application/ports.js';

declare module 'fastify' {
  interface FastifyRequest {
    currentUser?: {
      id: number;
      googleSub: string;
      email: string;
      name: string;
      role: UserRole;
      studentId?: string;
    };
  }
}

export interface AuthPluginOptions {
	config: Env;
	clock: Clock;
	sessions: AuthSessionStore;
	logger: AppLogger;
}

async function resolveSession(
	request: FastifyRequest,
	reply: FastifyReply,
	cfg: Env,
	clock: Clock,
	sessions: AuthSessionStore,
	appLogger: AppLogger,
	allowedOrigins: ReadonlySet<string>,
): Promise<void> {
  const sid = request.cookies[cfg.SESSION_COOKIE_NAME];
  if (!sid) return;

  // WebGL files are intentionally executable but untrusted. They are hosted on
  // the API origin for Unity storage compatibility, so never honor an API
  // session cookie unless the browser request came from the configured web UI.
  if (!isAllowedSessionSource(request.headers, allowedOrigins)) return;

	const session = await sessions.find(sid);

  if (!session) return;

	const now = clock.now();
  // Absolute cutoff or idle expiry — either terminates the session.
	if (session.expiresAt < now || isIdleExpired(session.lastSeenAt, now, cfg.SESSION_IDLE_MS)) {
		await sessions.delete(sid).catch((error) => {
			appLogger.warn(
				{ errorType: error instanceof Error ? error.name : 'unknown' },
				'Failed to delete expired session',
			);
		});
    reply.clearCookie(cfg.SESSION_COOKIE_NAME, {
      path: '/',
      secure: cfg.COOKIE_SECURE,
      sameSite: cfg.COOKIE_SAME_SITE,
    });
    return;
  }

  // Sliding refresh: only touch + re-issue cookie when lastSeenAt is stale enough,
  // so every request doesn't trigger a DB write and a Set-Cookie.
  const sinceTouch = now.getTime() - session.lastSeenAt.getTime();
  if (sinceTouch >= cfg.SESSION_TOUCH_MIN_INTERVAL_MS) {
		try {
			await sessions.touch(sid, now);
			reply.setCookie(cfg.SESSION_COOKIE_NAME, sid, {
				httpOnly: true,
				secure: cfg.COOKIE_SECURE,
				sameSite: cfg.COOKIE_SAME_SITE,
				path: '/',
				expires: cookieExpiresAt(session, now, cfg.SESSION_IDLE_MS),
			});
		} catch (error) {
			appLogger.warn(
				{ errorType: error instanceof Error ? error.name : 'unknown' },
				'Failed to touch session',
			);
		}
  }

  request.currentUser = {
    id: session.user.id,
    googleSub: session.user.googleSub,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role,
    studentId: session.user.studentId ?? extractStudentIdFromEmail(session.user.email),
  };
}

export async function registerAuth(app: FastifyInstance, options: AuthPluginOptions): Promise<void> {
	const cfg = options.config;
	const allowedOrigins = new Set(cfg.CORS_ALLOWED_ORIGINS);
	app.addHook('onRequest', async (request, reply) => {
		await resolveSession(
			request,
			reply,
			cfg,
			options.clock,
			options.sessions,
			options.logger,
			allowedOrigins,
		);
	});
}

export async function requireLogin(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.currentUser) throw unauthorized();
}

export function requireRole(...roles: UserRole[]) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!request.currentUser) throw unauthorized();
    if (!roles.includes(request.currentUser.role)) {
      throw forbidden('Insufficient permissions');
    }
  };
}
