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

	// Chrome Private Network Access: 공개 사이트(GitHub Pages)에서
	// IP 주소 기반 API로 요청 시 preflight에 PNA 헤더가 필요
	app.addHook('onRequest', async (request, reply) => {
		if (request.headers['access-control-request-private-network'] === 'true') {
			reply.header('Access-Control-Allow-Private-Network', 'true');
		}
	});
}
