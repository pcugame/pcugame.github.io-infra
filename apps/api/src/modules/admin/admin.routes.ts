import type { FastifyInstance } from 'fastify';
import { adminYearRoutes } from './admin-year.routes.js';
import { adminProjectRoutes } from './admin-project.routes.js';
import { adminMemberRoutes } from './admin-member.routes.js';
import { adminGameUploadRoutes } from './admin-game-upload.routes.js';
import { adminBannedIpRoutes } from './admin-banned-ip.routes.js';
import { adminSettingsRoutes } from './admin-settings.routes.js';

export async function adminRoutes(app: FastifyInstance): Promise<void> {
	await app.register(adminYearRoutes);
	await app.register(adminProjectRoutes);
	await app.register(adminMemberRoutes);
	await app.register(adminGameUploadRoutes);
	await app.register(adminBannedIpRoutes);
	await app.register(adminSettingsRoutes);
}
