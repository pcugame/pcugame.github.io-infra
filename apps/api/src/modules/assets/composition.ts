import { createBanMutationQueue } from '../../shared/ban-mutation-queue.js';
import type { FastifyPluginAsync } from 'fastify';
import type { AppLogger } from '../../application/ports.js';
import type { DownloadRateLimiter } from '../../shared/download-rate-limit.js';
import type { Env } from '../../config/env.js';
import type { BannedIpServiceDependencies } from '../admin/banned-ip/ports.js';
import { createBannedIpService } from '../admin/banned-ip/service.js';
import { createBannedIpController } from '../admin/banned-ip/controller.js';
import { createAssetsService } from './service.js';
import type { AssetsServiceDependencies, AssetsService, AssetDeletionUnitOfWork } from './ports.js';
import type { AutomaticBanRepository } from '../admin/banned-ip/ports.js';
import { createBannedIpStartupGate, createBannedIpWarmup, createDownloadRestriction } from '../admin/banned-ip/runtime.js';
import type { UploadLifecycleRuntime } from '../upload-lifecycle/ports.js';

export interface AssetsBannedProductionGraph {
	assetsService: AssetsService;
	bannedIpController: FastifyPluginAsync;
	warmup: { start(): Promise<void> };
}

export interface AssetsBannedProductionDependencies {
	config: Pick<Env, 'DOWNLOAD_AUTO_IP_BAN_ENABLED' | 'S3_BUCKET_PROTECTED'>;
	assetsRepository: AssetsServiceDependencies['repository'];
 deletion: AssetDeletionUnitOfWork;
	bannedIpRepository: BannedIpServiceDependencies['repository'] & AutomaticBanRepository;
	downloadLimiter: DownloadRateLimiter;
	logger: AppLogger;
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
	const mutateBan = createBanMutationQueue();

 const assetsService = createAssetsService({
  protectedBucket: deps.config.S3_BUCKET_PROTECTED,
  deletion: deps.deletion,
  checkDownloadLimit: createDownloadRestriction({ gate, repository: deps.bannedIpRepository, mutateBan }),
  wakeDeletionWorker: deps.uploadLifecycle.wakeDeletionWorker,
  logger: deps.logger,
  repository: deps.assetsRepository,
 });
	const bannedIpService = createBannedIpService({
		mutateBan,
		repository: deps.bannedIpRepository,
		autoIpBanEnabled: deps.config.DOWNLOAD_AUTO_IP_BAN_ENABLED,
		banCache: { add: gate.add, remove: gate.remove },
	});

	return {
		assetsService,
		bannedIpController: createBannedIpController({ service: bannedIpService }),
		warmup: createBannedIpWarmup({
			repository: deps.bannedIpRepository,
			autoIpBanEnabled: deps.config.DOWNLOAD_AUTO_IP_BAN_ENABLED,
			gate,
			logger: deps.logger,
		}),
	};
}
