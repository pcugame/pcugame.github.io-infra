import type { AssetKind } from '@pcu/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { AppLogger, Clock, ObjectStorage } from '../../application/ports.js';
import type { DownloadRateLimiter } from '../../shared/download-rate-limit.js';
import type { Env } from '../../config/env.js';
import type { createProjectAccessService } from '../admin/project-access.service.js';
import type { BannedIpServiceDependencies } from '../admin/banned-ip/service.js';
import { createBannedIpService } from '../admin/banned-ip/service.js';
import { createBannedIpController } from '../admin/banned-ip/controller.js';
import {
	createAssetsService,
	createBannedIpStartupGate,
	createBannedIpWarmup,
	type AssetsServiceDependencies,
} from './service.js';
import { createAssetsController } from './controller.js';
import type { UploadLifecycleRuntime } from '../upload-lifecycle/ports.js';

export interface AssetsBannedProductionGraph {
	assetsController: FastifyPluginAsync;
	bannedIpController: FastifyPluginAsync;
	warmup: { start(): Promise<void> };
}

export interface AssetsBannedProductionDependencies {
	config: Pick<Env, 'S3_BUCKET_PUBLIC' | 'S3_BUCKET_PROTECTED' | 'S3_PRESIGN_TTL_SEC'>;
	assetsRepository: AssetsServiceDependencies['repository'] & {
		findAllBannedIps(): Promise<{ ip: string }[]>;
	};
	bannedIpRepository: BannedIpServiceDependencies['repository'];
	projectAccess: ReturnType<typeof createProjectAccessService>;
	storage: ObjectStorage;
	downloadLimiter: DownloadRateLimiter;
	logger: AppLogger;
	clock: Clock;
	uploadLifecycle: UploadLifecycleRuntime;
}

/**
 * Compose the complete assets/banned-IP vertical slice from context-owned ports.
 * This function allocates only in-memory adapters; queries, storage calls and
 * timers remain at zero until the context owner explicitly starts resources.
 */
export function createAssetsBannedProductionGraph(
	deps: AssetsBannedProductionDependencies,
): AssetsBannedProductionGraph {
	const gate = createBannedIpStartupGate(deps.downloadLimiter);

	const assetsService = createAssetsService({
		presignTtlSec: deps.config.S3_PRESIGN_TTL_SEC,
		presign: (bucket, key, options) => deps.storage.presign(bucket, key, options),
		bucketForKind: (kind: AssetKind) => (
			kind === 'GAME' || kind === 'VIDEO'
				? deps.config.S3_BUCKET_PROTECTED
				: deps.config.S3_BUCKET_PUBLIC
		),
		wakeDeletionWorker: deps.uploadLifecycle.wakeDeletionWorker,
		loadProjectWithAccess: deps.projectAccess.loadProjectWithAccess,
		downloadLimiter: gate,
		logger: deps.logger,
		repository: deps.assetsRepository,
	});
	const bannedIpService = createBannedIpService({
		repository: deps.bannedIpRepository,
		banCache: { remove: gate.remove },
	});

	return {
		assetsController: createAssetsController({ service: assetsService }),
		bannedIpController: createBannedIpController({ service: bannedIpService }),
		warmup: createBannedIpWarmup({
			repository: deps.assetsRepository,
			gate,
			logger: deps.logger,
		}),
	};
}
