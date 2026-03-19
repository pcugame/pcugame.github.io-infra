import type { FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { env } from '../config/env.js';

export async function registerCookie(app: FastifyInstance): Promise<void> {
  await app.register(fastifyCookie, {
    secret: env().SESSION_SECRET,
    parseOptions: {},
  });
}
