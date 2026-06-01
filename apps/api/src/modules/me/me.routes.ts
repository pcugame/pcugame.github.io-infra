import type { FastifyInstance } from 'fastify';
import { meProjectController } from './project/index.js';

export async function meRoutes(app: FastifyInstance): Promise<void> {
	await app.register(meProjectController);
}
