import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { unauthorized, forbidden } from '../shared/errors.js';
import type { UserRole } from '@prisma/client';

declare module 'fastify' {
  interface FastifyRequest {
    currentUser?: {
      id: string;
      googleSub: string;
      email: string;
      name: string;
      role: UserRole;
    };
  }
}

async function resolveSession(request: FastifyRequest): Promise<void> {
  const cookieName = env().SESSION_COOKIE_NAME;
  const sid = request.cookies[cookieName];
  if (!sid) return;

  const session = await prisma.authSession.findUnique({
    where: { id: sid },
    include: { user: true },
  });

  if (!session) return;
  if (session.expiresAt < new Date()) {
    await prisma.authSession.delete({ where: { id: sid } }).catch(() => {});
    return;
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
  app.addHook('onRequest', async (request) => {
    await resolveSession(request);
  });
}

export function requireLogin(request: FastifyRequest, _reply: FastifyReply): void {
  if (!request.currentUser) throw unauthorized();
}

export function requireRole(...roles: UserRole[]) {
  return (request: FastifyRequest, _reply: FastifyReply): void => {
    if (!request.currentUser) throw unauthorized();
    if (!roles.includes(request.currentUser.role)) {
      throw forbidden('Insufficient permissions');
    }
  };
}
