import type { FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import type { Env } from '../config/env.js';

declare module 'fastify' {
	interface FastifyContextConfig {
		cors?: boolean;
	}
}

export async function registerCors(app: FastifyInstance, config: Env): Promise<void> {
	await app.register(fastifyCors, {
		origin: config.CORS_ALLOWED_ORIGINS,
		credentials: true,
		methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
		allowedHeaders: ['Content-Type', 'Authorization', 'Cookie'],
		exposedHeaders: [
			'X-Request-Id',
			'X-RateLimit-Limit',
			'X-RateLimit-Remaining',
			'X-RateLimit-Reset',
			'Retry-After',
		],
	});

	// Chrome Private Network Access: 공개 사이트(GitHub Pages)에서
	// IP 주소 기반 API로 요청 시 preflight에 PNA 헤더가 필요
	app.addHook('onRequest', async (request, reply) => {
		if (request.headers['access-control-request-private-network'] === 'true') {
			reply.header('Access-Control-Allow-Private-Network', 'true');
		}
	});
}
