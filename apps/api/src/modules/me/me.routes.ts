import type { FastifyPluginAsync } from 'fastify';

export function createMeRoutes(deps: {
	projectController: FastifyPluginAsync;
	webglDisplayController?: FastifyPluginAsync;
}): FastifyPluginAsync {
	return async function meRoutes(app): Promise<void> {
		await app.register(deps.projectController);
		if (deps.webglDisplayController) await app.register(deps.webglDisplayController);
	};
}
