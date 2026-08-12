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
import type { Env } from '../../../config/env.js';
import type { UploadLimits } from '../../../shared/upload-limits.js';
import { megabytes, resolveRoleUploadLimits } from '../../../shared/upload-policy.js';
import { createYearController } from './controller.js';
import { createExhibitionPosterUploadCoordinator } from './poster-upload.adapter.js';
import type { ExhibitionRepository } from './ports.js';
import { createExhibitionService } from './service.js';
import type { UploadLifecycleRuntime } from '../../upload-lifecycle/ports.js';

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
	repository: ExhibitionRepository;
	storage: ObjectStorage;
	fileSystem: FileSystem;
	settings: SettingsStore;
	uploadLimiter: UploadLimiter;
	logger: AppLogger;
	clock: Clock;
	ids: IdGenerator;
	uploadLifecycle: UploadLifecycleRuntime;
}

function uploadLimits(config: YearConfig, role: UserRole): UploadLimits {
	return resolveRoleUploadLimits(config, role);
}

/** Compose ticket-009 solely from resources owned by one BackendContext. */
export function createYearProductionGraph(
	deps: YearProductionDependencies,
): YearProductionGraph {
	const posterUpload = createExhibitionPosterUploadCoordinator({
		bucket: deps.config.S3_BUCKET_PUBLIC,
		storage: deps.storage,
		fileSystem: deps.fileSystem,
		ids: deps.ids,
		logger: deps.logger,
		deleteUnpersistedObject: (key) => deps.uploadLifecycle.orphanDeletions.deleteOrQueue(
			deps.config.S3_BUCKET_PUBLIC,
			key,
			'exhibition-poster-unpersisted',
		),
		uploadIntents: deps.uploadLifecycle.uploadIntents,
	});
	const service = createExhibitionService({
		apiPublicUrl: deps.config.API_PUBLIC_URL,
		posterBucket: deps.config.S3_BUCKET_PUBLIC,
		protectedBucket: deps.config.S3_BUCKET_PROTECTED,
		repository: deps.repository,
		uploadLimits: (role) => uploadLimits(deps.config, role),
		uploadSlots: deps.uploadLimiter,
		posterUpload,
		wakeDeletionWorker: deps.uploadLifecycle.wakeDeletionWorker,
		wakeMaintenance: deps.uploadLifecycle.wakeMaintenance,
		logger: deps.logger,
		recordPostCommitCleanupFailure:
			deps.uploadLifecycle.metrics.recordPostCommitCleanupFailure,
	});

	return {
		exhibitionController: createYearController({
			service,
			uploadBodyLimit: megabytes(deps.config.UPLOAD_PRIVILEGED_REQUEST_MAX_MB),
		}),
	};
}
