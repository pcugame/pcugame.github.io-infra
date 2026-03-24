import type { FastifyInstance } from 'fastify';
import { OAuth2Client } from 'google-auth-library';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { sendOk } from '../../shared/http.js';
import { unauthorized } from '../../shared/errors.js';
import { parseBody, GoogleLoginBody } from '../../shared/validation.js';
import { generateSessionId, sessionExpiresAt } from '../../shared/session.js';
import { logger } from '../../lib/logger.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const cfg = env();
  const oauthClient = new OAuth2Client();

  // POST /api/auth/google
  app.post('/auth/google', async (request, reply) => {
    const { credential } = parseBody(GoogleLoginBody, request.body);

    let payload;
    try {
      const ticket = await oauthClient.verifyIdToken({
        idToken: credential,
        audience: cfg.GOOGLE_CLIENT_IDS,
      });
      payload = ticket.getPayload();
    } catch (err) {
      logger.error({ err, configuredAudience: cfg.GOOGLE_CLIENT_IDS }, 'Google token verification failed');
      throw unauthorized('Invalid Google token');
    }

    if (!payload?.sub || !payload.email) throw unauthorized('Invalid token payload');

    logger.info({ email: payload.email, hd: payload.hd, allowedHd: cfg.ALLOWED_GOOGLE_HD }, 'Google login attempt');

    if (cfg.ALLOWED_GOOGLE_HD && payload.hd !== cfg.ALLOWED_GOOGLE_HD) {
      logger.warn({ hd: payload.hd, allowedHd: cfg.ALLOWED_GOOGLE_HD }, 'Email domain rejected');
      throw unauthorized('Email domain not allowed');
    }

    const user = await prisma.user.upsert({
      where: { googleSub: payload.sub },
      create: {
        googleSub: payload.sub,
        email: payload.email,
        name: payload.name ?? '',
        picture: payload.picture ?? '',
      },
      update: {
        email: payload.email,
        name: payload.name ?? '',
        picture: payload.picture ?? '',
      },
    });

    const sessionId = generateSessionId();
    const expiresAt = sessionExpiresAt();
    await prisma.authSession.create({
      data: { id: sessionId, userId: user.id, expiresAt },
    });

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

  // POST /api/auth/logout
  app.post('/auth/logout', async (request, reply) => {
    // Only process logout if the user has a valid (non-expired) session,
    // which mitigates CSRF-triggered forced logout.
    if (!request.currentUser) {
      reply.clearCookie(cfg.SESSION_COOKIE_NAME, {
        path: '/',
        secure: cfg.COOKIE_SECURE,
        sameSite: cfg.COOKIE_SAME_SITE,
      });
      sendOk(reply, { message: 'Logged out' });
      return;
    }

    const sid = request.cookies[cfg.SESSION_COOKIE_NAME];
    if (sid) {
      await prisma.authSession.deleteMany({ where: { id: sid } }).catch(() => {});
    }
    reply.clearCookie(cfg.SESSION_COOKIE_NAME, {
      path: '/',
      secure: cfg.COOKIE_SECURE,
      sameSite: cfg.COOKIE_SAME_SITE,
    });
    sendOk(reply, { message: 'Logged out' });
  });

  // GET /api/me
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
