import type { FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import type { Env } from '../config/env.js';

export async function registerCookie(app: FastifyInstance, config: Env): Promise<void> {
  await app.register(fastifyCookie, {
    secret: config.SESSION_SECRET,
    parseOptions: {},
  });
}
