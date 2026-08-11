import type { UserRole } from '@pcu/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type {
	AppLogger,
	Clock,
	FileSystem,
	IdGenerator,
	ObjectStorage,
	SettingsStore,
	UploadLimiter,
} from '../../../application/ports.js';
import { createObjectDeletionCoordinator } from '../../../application/object-deletion.js';
import type { Env } from '../../../config/env.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import type { UploadLimits } from '../../../shared/upload-limits.js';
import { megabytes, resolveRoleUploadLimits } from '../../../shared/upload-policy.js';
import { createOrphanRepository } from '../../orphan/repository.js';
import { createOrphanService } from '../../orphan/service.js';
import { createObjectReferenceResolver } from '../../orphan/reference-resolver.js';
import { createYearController } from './controller.js';
import { createExhibitionPosterUploadCoordinator } from './poster-upload.adapter.js';
import { createExhibitionRepository } from './repository.js';
import { createExhibitionService } from './service.js';
import { createUploadIntentService } from '../../upload-intent/service.js';
import { createUploadIntentRepository } from '../../upload-intent/repository.js';
import type { UploadLifecycleMetrics } from '../../../lib/upload-lifecycle-metrics.js';

type YearConfig = Pick<
	Env,
	| 'API_PUBLIC_URL'
	| 'S3_BUCKET_PUBLIC'
	| 'S3_BUCKET_PROTECTED'
	| 'UPLOAD_USER_IMAGE_MAX_MB'
	| 'UPLOAD_USER_GAME_MAX_MB'
	| 'UPLOAD_USER_REQUEST_MAX_MB'
	| 'UPLOAD_USER_MAX_FILES'
	| 'UPLOAD_PRIVILEGED_IMAGE_MAX_MB'
	| 'UPLOAD_PRIVILEGED_GAME_MAX_MB'
	| 'UPLOAD_PRIVILEGED_REQUEST_MAX_MB'
	| 'UPLOAD_PRIVILEGED_MAX_FILES'
>;

export interface YearProductionGraph {
	exhibitionController: FastifyPluginAsync;
}

export interface YearProductionDependencies {
	config: YearConfig;
	prisma: PrismaClient;
	storage: ObjectStorage;
	fileSystem: FileSystem;
	settings: SettingsStore;
	uploadLimiter: UploadLimiter;
	logger: AppLogger;
	clock: Clock;
	ids: IdGenerator;
	uploadLifecycleMetrics?: UploadLifecycleMetrics;
}

function uploadLimits(config: YearConfig, role: UserRole): UploadLimits {
	return resolveRoleUploadLimits(config, role);
}

/** Compose ticket-009 solely from resources owned by one BackendContext. */
export function createYearProductionGraph(
	deps: YearProductionDependencies,
): YearProductionGraph {
	const prismaCapabilities = deps.prisma as unknown as Record<string, unknown>;
	const durableUploadsEnabled = Boolean(
		prismaCapabilities['uploadIntent']
		&& prismaCapabilities['orphanObject']
		&& typeof prismaCapabilities['$queryRaw'] === 'function',
	);
	const repository = createExhibitionRepository(deps.prisma);
	const orphanService = createOrphanService({
		clock: deps.clock,
		storage: deps.storage,
		repository: createOrphanRepository(deps.prisma),
		...(durableUploadsEnabled ? {
			references: createObjectReferenceResolver(
				deps.prisma,
				{
					publicBucket: deps.config.S3_BUCKET_PUBLIC,
					protectedBucket: deps.config.S3_BUCKET_PROTECTED,
				},
				deps.logger,
			),
		} : {}),
		logger: deps.logger,
	});
	const deletion = createObjectDeletionCoordinator({
		storage: deps.storage,
		orphans: { record: orphanService.recordOrphan },
		logger: deps.logger,
		...(durableUploadsEnabled ? {
			reapDurablyQueued: () => orphanService.runOrphanReaper(),
		} : {}),
	});
	const uploadIntents = createUploadIntentService({
		prisma: deps.prisma,
		repository: createUploadIntentRepository(deps.prisma),
		storage: deps.storage,
		buckets: {
			publicBucket: deps.config.S3_BUCKET_PUBLIC,
			protectedBucket: deps.config.S3_BUCKET_PROTECTED,
		},
		clock: deps.clock,
		ids: deps.ids,
		logger: deps.logger,
	});
	const posterUpload = createExhibitionPosterUploadCoordinator({
		bucket: deps.config.S3_BUCKET_PUBLIC,
		storage: deps.storage,
		fileSystem: deps.fileSystem,
		ids: deps.ids,
		logger: deps.logger,
		deleteUnpersistedObject: (key) => deletion.deleteOrQueue(
			deps.config.S3_BUCKET_PUBLIC,
			key,
			'exhibition-poster-unpersisted',
		),
		...(durableUploadsEnabled ? { uploadIntents } : {}),
	});
	const service = createExhibitionService({
		apiPublicUrl: deps.config.API_PUBLIC_URL,
		posterBucket: deps.config.S3_BUCKET_PUBLIC,
		repository,
		uploadLimits: (role) => uploadLimits(deps.config, role),
		uploadSlots: deps.uploadLimiter,
		posterUpload,
		deleteOrQueue: deletion.deleteDurablyQueued,
		logger: deps.logger,
		...(deps.uploadLifecycleMetrics ? {
			recordPostCommitCleanupFailure:
				deps.uploadLifecycleMetrics.recordPostCommitCleanupFailure,
		} : {}),
	});

	return {
		exhibitionController: createYearController({
			service,
			uploadBodyLimit: megabytes(deps.config.UPLOAD_PRIVILEGED_REQUEST_MAX_MB),
		}),
	};
}
