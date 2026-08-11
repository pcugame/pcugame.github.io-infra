import type { FastifyPluginAsync } from 'fastify';

export function createMeRoutes(deps: {
	projectController: FastifyPluginAsync;
}): FastifyPluginAsync {
	return async function meRoutes(app): Promise<void> {
		await app.register(deps.projectController);
	};
}
