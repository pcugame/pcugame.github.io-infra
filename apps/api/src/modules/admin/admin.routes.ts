import type { FastifyPluginAsync } from 'fastify';

export interface AdminRouteDependencies {
	projectController: FastifyPluginAsync;
	memberController: FastifyPluginAsync;
	settingsController: FastifyPluginAsync;
	bannedIpController: FastifyPluginAsync;
	exhibitionController: FastifyPluginAsync;
	/** Legacy route families expire in their numbered wiring tickets. */
	legacy: {
		projectMultipartController: FastifyPluginAsync;
		gameUploadController: FastifyPluginAsync;
		importController: FastifyPluginAsync;
		exportController: FastifyPluginAsync;
	};
}

/** Registration itself is pure; migrated ticket-008/009 controllers are explicit ports. */
export function createAdminRoutes(deps: AdminRouteDependencies): FastifyPluginAsync {
	return async function adminRoutes(app): Promise<void> {
		await app.register(deps.exhibitionController);
		await app.register(deps.projectController);
		await app.register(deps.legacy.projectMultipartController);
		await app.register(deps.memberController);
		await app.register(deps.legacy.gameUploadController);
		await app.register(deps.bannedIpController);
		await app.register(deps.settingsController);
		await app.register(deps.legacy.importController);
		await app.register(deps.legacy.exportController);
	};
}
