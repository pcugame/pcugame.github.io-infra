import type { FastifyPluginAsync } from 'fastify';
import type { Env } from '../../../config/env.js';
import { createYearController } from './controller.js';
import type { ExhibitionRepository } from './ports.js';
import { createExhibitionService } from './service.js';
import type { UploadLifecycleRuntime } from '../../upload-lifecycle/ports.js';

type YearConfig = Pick<
	Env,
	| 'PUBLIC_ASSET_ORIGIN'
	| 'S3_BUCKET_PUBLIC'
	| 'S3_BUCKET_PROTECTED'
>;

export interface YearProductionGraph {
	exhibitionController: FastifyPluginAsync;
}

export interface YearProductionDependencies {
	config: YearConfig;
	repository: ExhibitionRepository;
	uploadLifecycle: UploadLifecycleRuntime;
}

/** Compose ticket-009 solely from resources owned by one BackendContext. */
export function createYearProductionGraph(
	deps: YearProductionDependencies,
): YearProductionGraph {
	const service = createExhibitionService({
		publicAssetOrigin: deps.config.PUBLIC_ASSET_ORIGIN,
		posterBucket: deps.config.S3_BUCKET_PUBLIC,
		protectedBucket: deps.config.S3_BUCKET_PROTECTED,
		repository: deps.repository,
		wakeDeletionWorker: deps.uploadLifecycle.wakeDeletionWorker,
	});

	return {
		exhibitionController: createYearController({ service }),
	};
}
