import type { FastifyPluginAsync } from 'fastify';
import { normalizePublicAssetOrigin } from '../../shared/public-origin.js';
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
		NODE_ENV: string;
		API_PUBLIC_URL: string;
		WEB_PUBLIC_URL: string;
		PUBLIC_ASSET_ORIGIN?: string;
		S3_BUCKET_PUBLIC: string;
	};
	repository: PublicProductionRepository;
	/** Accepted by the root composition for uniform logging ownership; canonical public reads emit no fallback logs. */
	logger: unknown;
}

/** Compose public reads exclusively from resources owned by one BackendContext. */
export function createPublicProductionGraph(
	deps: PublicProductionDependencies,
): PublicProductionGraph {
	const repository = deps.repository;
	const publicAssetOrigin = deps.config.PUBLIC_ASSET_ORIGIN ?? deps.config.API_PUBLIC_URL;
	if (deps.config.NODE_ENV === 'production' && (
		!deps.config.PUBLIC_ASSET_ORIGIN
		|| normalizePublicAssetOrigin(publicAssetOrigin) === normalizePublicAssetOrigin(deps.config.API_PUBLIC_URL)
	)) {
		throw new Error('Production public asset delivery requires a dedicated PUBLIC_ASSET_ORIGIN');
	}
	const service = createPublicService({
		apiPublicUrl: deps.config.API_PUBLIC_URL,
		publicAssetOrigin,
		publicBucket: deps.config.S3_BUCKET_PUBLIC,
		repository,
	});
	return {
		repository,
		service,
		controller: createPublicController({ service }),
	};
}
