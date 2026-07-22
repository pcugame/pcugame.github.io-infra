import type { AssetKind } from '@pcu/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { AppLogger, Clock, ObjectStorage, SettingsStore } from '../../application/ports.js';
import type { DownloadRateLimiter } from '../../shared/download-rate-limit.js';
import type { Env } from '../../config/env.js';
import { createObjectDeletionCoordinator } from '../../application/object-deletion.js';
import { createOrphanRepository } from '../orphan/repository.js';
import { createOrphanService } from '../orphan/service.js';
import { createProjectAccessRepository } from '../admin/project-access.repository.js';
import { createProjectAccessService } from '../admin/project-access.service.js';
import { createBannedIpRepository } from '../admin/banned-ip/repository.js';
import { createBannedIpService } from '../admin/banned-ip/service.js';
import { createBannedIpController } from '../admin/banned-ip/controller.js';
import { createAssetsRepository } from './repository.js';
import {
	createAssetsService,
	createBannedIpStartupGate,
	createBannedIpWarmup,
} from './service.js';
import { createAssetsController } from './controller.js';

export interface AssetsBannedProductionGraph {
	assetsController: FastifyPluginAsync;
	bannedIpController: FastifyPluginAsync;
	warmup: { start(): Promise<void> };
}

export interface AssetsBannedProductionDependencies {
	config: Pick<Env, 'S3_BUCKET_PUBLIC' | 'S3_BUCKET_PROTECTED'>;
	prisma: PrismaClient;
	storage: ObjectStorage;
	downloadLimiter: DownloadRateLimiter;
	settings: SettingsStore;
	logger: AppLogger;
	clock: Clock;
}

/**
 * Compose the complete assets/banned-IP vertical slice from context-owned ports.
 * This function allocates only in-memory adapters; queries, storage calls and
 * timers remain at zero until the context owner explicitly starts resources.
 */
export function createAssetsBannedProductionGraph(
	deps: AssetsBannedProductionDependencies,
): AssetsBannedProductionGraph {
	const assetsRepository = createAssetsRepository(deps.prisma);
	const bannedIpRepository = createBannedIpRepository(deps.prisma);
	const projectAccess = createProjectAccessService(createProjectAccessRepository(deps.prisma));
	const orphanService = createOrphanService({
		clock: deps.clock,
		storage: deps.storage,
		repository: createOrphanRepository(deps.prisma),
		logger: deps.logger,
	});
	const deletion = createObjectDeletionCoordinator({
		storage: deps.storage,
		orphans: { record: orphanService.recordOrphan },
		logger: deps.logger,
	});
	const gate = createBannedIpStartupGate(deps.downloadLimiter);

	// Settings is deliberately part of the context-owned slice boundary even
	// though current download limits are fixed by the existing HTTP contract.
	// Ticket 008 may consume it without reaching back to a process singleton.
	void deps.settings;

	const assetsService = createAssetsService({
		publicBucket: deps.config.S3_BUCKET_PUBLIC,
		protectedBucket: deps.config.S3_BUCKET_PROTECTED,
		presign: (bucket, key, options) => deps.storage.presign(bucket, key, options),
		bucketForKind: (kind: AssetKind) => (
			kind === 'GAME' || kind === 'VIDEO'
				? deps.config.S3_BUCKET_PROTECTED
				: deps.config.S3_BUCKET_PUBLIC
		),
		deleteOrQueue: deletion.deleteOrQueue,
		loadProjectWithAccess: projectAccess.loadProjectWithAccess,
		downloadLimiter: gate,
		logger: deps.logger,
		repository: assetsRepository,
	});
	const bannedIpService = createBannedIpService({
		repository: bannedIpRepository,
		banCache: { remove: gate.remove },
	});

	return {
		assetsController: createAssetsController({ service: assetsService }),
		bannedIpController: createBannedIpController({ service: bannedIpService }),
		warmup: createBannedIpWarmup({
			repository: assetsRepository,
			gate,
			logger: deps.logger,
		}),
	};
}
