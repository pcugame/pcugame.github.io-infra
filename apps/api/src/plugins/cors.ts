import type { FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import { env } from '../config/env.js';

export async function registerCors(app: FastifyInstance): Promise<void> {
  await app.register(fastifyCors, {
    origin: env().CORS_ALLOWED_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Cookie'],
  });
}
