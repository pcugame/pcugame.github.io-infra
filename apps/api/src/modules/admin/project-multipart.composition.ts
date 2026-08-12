import type { AssetKind, UserRole } from '@pcu/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type {
	AppLogger,
	Clock,
	FileSystem,
	IdGenerator,
	ObjectStorage,
	SettingsStore,
	UploadLimiter,
} from '../../application/ports.js';
import type { Env } from '../../config/env.js';
import {
	bucketForAssetKind,
	megabytes,
	resolveRoleUploadLimits,
	type UploadLimits,
} from '../../shared/upload-policy.js';
import type { createProjectAccessService } from './project-access.service.js';
import {
	createAdminProjectMultipartController,
	createAdminProjectSubmitController,
	createProjectAssetUploadController,
} from './project/multipart.controller.js';
import { createProjectAssetUploadCoordinator } from './project/project-asset-upload.adapter.js';
import { createProjectAssetService } from './project/project-asset.service.js';
import { createSubmitProjectService } from './project/project-submit.service.js';
import { createProjectUploadPipeline } from './project/project-upload.adapter.js';
import type { ProjectUploadProcessing } from './project/project-upload.adapter.js';
import type { ProjectApplicationRepository } from './project/ports.js';
import type { MultipartRequestHasher } from '../../application/upload-ports.js';
import { createMultipartCollector } from '../assets/upload/multipart-collector.js';
import { createMeProjectController } from '../me/project/controller.js';
import { createMeRoutes } from '../me/me.routes.js';
import type { UploadLifecycleRuntime } from '../upload-lifecycle/ports.js';

type ProjectMultipartConfig = Pick<
	Env,
	| 'WEB_PUBLIC_URL'
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
	| 'RATE_LIMIT_SUBMIT_MAX'
	| 'RATE_LIMIT_SUBMIT_WINDOW_MS'
>;

export interface ProjectMultipartProductionGraph {
	projectMultipartController: FastifyPluginAsync;
	meController: FastifyPluginAsync;
	/** Identity seams proving ticket-008 access/repository reuse. */
	projectAccess: ReturnType<typeof createProjectAccessService>;
	projectRepository: ProjectApplicationRepository;
}

export interface ProjectMultipartProductionDependencies {
	config: ProjectMultipartConfig;
	storage: ObjectStorage;
	fileSystem: FileSystem;
	settings: SettingsStore;
	uploadLimiter: UploadLimiter;
	logger: AppLogger;
	clock: Clock;
	ids: IdGenerator;
	processing: ProjectUploadProcessing;
	requestHasher: MultipartRequestHasher;
	access: ReturnType<typeof createProjectAccessService>;
	repository: ProjectApplicationRepository;
	uploadLifecycle: UploadLifecycleRuntime;
}

async function uploadLimits(
	config: ProjectMultipartConfig,
	settings: SettingsStore,
	role: UserRole,
): Promise<UploadLimits> {
	const site = await settings.get();
	return resolveRoleUploadLimits(config, role, { maxGameFileMb: site.maxGameFileMb });
}

function bucketForKind(kind: AssetKind, config: ProjectMultipartConfig): string {
	return bucketForAssetKind(kind, {
		publicBucket: config.S3_BUCKET_PUBLIC,
		protectedBucket: config.S3_BUCKET_PROTECTED,
	});
}

/** Compose ticket-011 exclusively from resources and ports owned by one context. */
export function createProjectMultipartProductionGraph(
	deps: ProjectMultipartProductionDependencies,
): ProjectMultipartProductionGraph {
	const createPipeline = () => createProjectUploadPipeline({
		storage: deps.storage,
		fileSystem: deps.fileSystem,
		ids: deps.ids,
		logger: deps.logger,
		processing: deps.processing,
		bucketForKind: (kind) => bucketForKind(kind, deps.config),
		deleteUnpersistedObject: deps.uploadLifecycle.orphanDeletions.deleteOrQueue,
		uploadIntents: deps.uploadLifecycle.uploadIntents,
	});
	const limits = (role: UserRole) => uploadLimits(deps.config, deps.settings, role);
	const submitService = createSubmitProjectService({
		webPublicUrl: deps.config.WEB_PUBLIC_URL,
		repository: deps.repository,
		uploadLimits: limits,
		uploadSlots: deps.uploadLimiter,
		createPipeline,
		multipartCollector: createMultipartCollector({
			fileSystem: deps.fileSystem,
			ids: deps.ids,
		}),
		logger: deps.logger,
		recordPostCommitCleanupFailure:
			deps.uploadLifecycle.metrics.recordPostCommitCleanupFailure,
		requestHasher: deps.requestHasher,
		idempotency: deps.uploadLifecycle.idempotency,
	});
	const assetService = createProjectAssetService({
		repository: deps.repository,
		uploadLimits: limits,
		uploadSlots: deps.uploadLimiter,
		uploadCoordinator: createProjectAssetUploadCoordinator({
			fileSystem: deps.fileSystem,
			ids: deps.ids,
			createPipeline,
			requestHasher: deps.requestHasher,
		}),
		bucketForKind: (kind) => bucketForKind(kind, deps.config),
		wakeDeletionWorker: deps.uploadLifecycle.wakeDeletionWorker,
		logger: deps.logger,
		recordPostCommitCleanupFailure:
			deps.uploadLifecycle.metrics.recordPostCommitCleanupFailure,
		idempotency: deps.uploadLifecycle.idempotency,
	});
	const route = {
		rateLimit: {
			max: deps.config.RATE_LIMIT_SUBMIT_MAX,
			timeWindow: deps.config.RATE_LIMIT_SUBMIT_WINDOW_MS,
		},
	};
	const adminSubmit = createAdminProjectSubmitController({
		service: submitService,
		route: {
			...route,
			bodyLimit: megabytes(deps.config.UPLOAD_PRIVILEGED_REQUEST_MAX_MB),
		},
	});
	const assetController = createProjectAssetUploadController({
		service: assetService,
		access: deps.access,
		bodyLimit: megabytes(deps.config.UPLOAD_PRIVILEGED_REQUEST_MAX_MB),
	});
	const meSubmit = createMeProjectController({
		service: submitService,
		route: {
			...route,
			bodyLimit: megabytes(deps.config.UPLOAD_USER_REQUEST_MAX_MB),
		},
	});

	return {
		projectMultipartController: createAdminProjectMultipartController({
			submitController: adminSubmit,
			assetController,
		}),
		meController: createMeRoutes({ projectController: meSubmit }),
		projectAccess: deps.access,
		projectRepository: deps.repository,
	};
}
