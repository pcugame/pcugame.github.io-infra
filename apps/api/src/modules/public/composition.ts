import type { FastifyPluginAsync } from 'fastify';
import type { AppLogger, ObjectStorage } from '../../application/ports.js';
import { createPublicController } from './controller.js';
import { createPublicImageService, type PublicImageRepository } from './image.service.js';
import { createPublicService, type PublicServiceDependencies } from './service.js';
import {
	createPublicWebglService,
	type PublicWebglRepository,
} from './webgl.service.js';

export type PublicProductionRepository = PublicServiceDependencies['repository']
	& PublicImageRepository
	& PublicWebglRepository;

export interface PublicProductionGraph {
	repository: PublicProductionRepository;
	service: ReturnType<typeof createPublicService>;
	imageService: ReturnType<typeof createPublicImageService>;
	webglService: ReturnType<typeof createPublicWebglService>;
	controller: FastifyPluginAsync;
}

export interface PublicProductionDependencies {
	config: {
		API_PUBLIC_URL: string;
		WEB_PUBLIC_URL: string;
		S3_BUCKET_PUBLIC: string;
	};
	repository: PublicProductionRepository;
	storage: ObjectStorage;
	logger: Pick<AppLogger, 'error'>;
}

/** Compose public reads exclusively from resources owned by one BackendContext. */
export function createPublicProductionGraph(
	deps: PublicProductionDependencies,
): PublicProductionGraph {
	const repository = deps.repository;
	const service = createPublicService({
		apiPublicUrl: deps.config.API_PUBLIC_URL,
		repository,
	});
	const imageService = createPublicImageService({
		publicBucket: deps.config.S3_BUCKET_PUBLIC,
		repository,
		storage: deps.storage,
		logger: deps.logger,
	});
	const webglService = createPublicWebglService({
		config: {
			apiPublicUrl: deps.config.API_PUBLIC_URL,
			webPublicUrl: deps.config.WEB_PUBLIC_URL,
			publicBucket: deps.config.S3_BUCKET_PUBLIC,
		},
		repository,
		storage: deps.storage,
	});
	return {
		repository,
		service,
		imageService,
		webglService,
		controller: createPublicController({ service, imageService, webglService }),
	};
}
