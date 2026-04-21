import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { unauthorized, forbidden } from '../shared/errors.js';
import { cookieExpiresAt, isIdleExpired } from '../shared/session.js';
import * as authRepo from '../modules/auth/repository.js';
import type { UserRole } from '@prisma/client';

declare module 'fastify' {
  interface FastifyRequest {
    currentUser?: {
      id: number;
      googleSub: string;
      email: string;
      name: string;
      role: UserRole;
    };
  }
}

async function resolveSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const cfg = env();
  const sid = request.cookies[cfg.SESSION_COOKIE_NAME];
  if (!sid) return;

  const session = await prisma.authSession.findUnique({
    where: { id: sid },
    include: { user: true },
  });

  if (!session) return;

  const now = new Date();
  // Absolute cutoff or idle expiry — either terminates the session.
  if (session.expiresAt < now || isIdleExpired(session.lastSeenAt, now)) {
    await prisma.authSession.delete({ where: { id: sid } }).catch(() => {});
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
    await authRepo.touchSession(sid, now).catch(() => {});
    reply.setCookie(cfg.SESSION_COOKIE_NAME, sid, {
      httpOnly: true,
      secure: cfg.COOKIE_SECURE,
      sameSite: cfg.COOKIE_SAME_SITE,
      path: '/',
      expires: cookieExpiresAt(session, now),
    });
  }

  request.currentUser = {
    id: session.user.id,
    googleSub: session.user.googleSub,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role,
  };
}

export async function registerAuth(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (request, reply) => {
    await resolveSession(request, reply);
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
