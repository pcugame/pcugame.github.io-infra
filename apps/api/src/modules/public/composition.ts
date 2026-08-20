import type { FastifyPluginAsync } from 'fastify';
import { createPublicController } from './controller.js';
import { createPublicService, type PublicServiceDependencies } from './service.js';

export type PublicProductionRepository = PublicServiceDependencies['repository'];

export interface PublicProductionGraph {
	repository: PublicProductionRepository;
	service: ReturnType<typeof createPublicService>;
	controller: FastifyPluginAsync;
}

export interface PublicProductionDependencies {
	config: {
		API_PUBLIC_URL: string;
		PUBLIC_ASSET_BASE_URL: string;
	};
	repository: PublicProductionRepository;
}

/** Compose public reads exclusively from resources owned by one BackendContext. */
export function createPublicProductionGraph(
	deps: PublicProductionDependencies,
): PublicProductionGraph {
	const repository = deps.repository;
	const service = createPublicService({
		apiPublicUrl: deps.config.API_PUBLIC_URL,
		publicAssetBaseUrl: deps.config.PUBLIC_ASSET_BASE_URL,
		repository,
	});
	return {
		repository,
		service,
		controller: createPublicController({ service }),
	};
}
