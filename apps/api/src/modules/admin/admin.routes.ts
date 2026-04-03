import type { FastifyInstance } from 'fastify';
import { adminYearRoutes } from './admin-year.routes.js';
import { adminProjectRoutes } from './admin-project.routes.js';
import { adminMemberRoutes } from './admin-member.routes.js';
import { adminGameUploadRoutes } from './admin-game-upload.routes.js';

export async function adminRoutes(app: FastifyInstance): Promise<void> {
	await app.register(adminYearRoutes);
	await app.register(adminProjectRoutes);
	await app.register(adminMemberRoutes);
	await app.register(adminGameUploadRoutes);
}
