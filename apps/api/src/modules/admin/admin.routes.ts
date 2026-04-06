import type { FastifyInstance } from 'fastify';
import { exhibitionController } from './year/index.js';
import { projectController } from './project/index.js';
import { memberController } from './member/index.js';
import { gameUploadController } from './game-upload/index.js';
import { bannedIpController } from './banned-ip/index.js';
import { settingsController } from './settings/index.js';
import { importController } from './import/index.js';

export async function adminRoutes(app: FastifyInstance): Promise<void> {
	await app.register(exhibitionController);
	await app.register(projectController);
	await app.register(memberController);
	await app.register(gameUploadController);
	await app.register(bannedIpController);
	await app.register(settingsController);
	await app.register(importController);
}
