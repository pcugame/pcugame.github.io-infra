import type { FastifyPluginAsync } from 'fastify';
import { exhibitionController } from './year/index.js';
import { projectController } from './project/index.js';
import { memberController } from './member/index.js';
import { gameUploadController } from './game-upload/index.js';
import { settingsController } from './settings/index.js';
import { importController } from './import/index.js';
import { exportController } from './export/index.js';

export function createAdminRoutes(deps: { bannedIpController: FastifyPluginAsync }): FastifyPluginAsync {
	return async function adminRoutes(app): Promise<void> {
		await app.register(exhibitionController);
		await app.register(projectController);
		await app.register(memberController);
		await app.register(gameUploadController);
		await app.register(deps.bannedIpController);
		await app.register(settingsController);
		await app.register(importController);
		await app.register(exportController);
	};
}
