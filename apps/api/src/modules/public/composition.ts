import type { FastifyPluginAsync } from 'fastify';
import type { ObjectStorage } from '../../application/ports.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { createPublicController } from './controller.js';
import { createPublicRepository } from './repository.js';
import { createPublicService } from './service.js';
import { createPublicWebglService } from './webgl.service.js';

export interface PublicProductionGraph {
	repository: ReturnType<typeof createPublicRepository>;
	service: ReturnType<typeof createPublicService>;
	webglService: ReturnType<typeof createPublicWebglService>;
	controller: FastifyPluginAsync;
}

export interface PublicProductionDependencies {
	config: {
		API_PUBLIC_URL: string;
		WEB_PUBLIC_URL: string;
		S3_BUCKET_PUBLIC: string;
	};
	prisma: PrismaClient;
	storage: ObjectStorage;
}

/** Compose public reads exclusively from resources owned by one BackendContext. */
export function createPublicProductionGraph(
	deps: PublicProductionDependencies,
): PublicProductionGraph {
	const repository = createPublicRepository(deps.prisma);
	const service = createPublicService({
		apiPublicUrl: deps.config.API_PUBLIC_URL,
		publicBucket: deps.config.S3_BUCKET_PUBLIC,
		presign: (bucket, key) => deps.storage.presign(bucket, key),
		repository,
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
		webglService,
		controller: createPublicController({ service, webglService }),
	};
}
