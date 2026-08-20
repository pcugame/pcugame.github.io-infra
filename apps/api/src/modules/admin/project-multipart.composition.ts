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
} from '../../application/ports.js';
import type { Env } from '../../config/env.js';
import {
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
import type {
	ActiveUploadTempRegistry,
	MultipartRequestHasher,
} from '../../application/upload-ports.js';
import { createMultipartCollector } from '../assets/upload/multipart-collector.js';
import { createMeProjectController } from '../me/project/controller.js';
import { createMeRoutes } from '../me/me.routes.js';
import type { UploadLifecycleRuntime } from '../upload-lifecycle/ports.js';

type ProjectMultipartConfig = Pick<
	Env,
	| 'WEB_PUBLIC_URL'
	| 'S3_BUCKET_PUBLIC'
	| 'INLINE_UPLOAD_MAX_BYTES'
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
	activeUploadTemps?: ActiveUploadTempRegistry;
}

async function uploadLimits(
	config: ProjectMultipartConfig,
	settings: SettingsStore,
	role: UserRole,
): Promise<UploadLimits> {
	const site = await settings.get();
	return resolveRoleUploadLimits(config, role, { maxGameFileMb: site.maxGameFileMb });
}

/** Compose ticket-011 exclusively from resources and ports owned by one context. */
export function createProjectMultipartProductionGraph(
	deps: ProjectMultipartProductionDependencies,
): ProjectMultipartProductionGraph {
	const inlineMaxBytes = deps.config.INLINE_UPLOAD_MAX_BYTES ?? megabytes(16);
	const createPipeline = () => createProjectUploadPipeline({
		storage: deps.storage,
		fileSystem: deps.fileSystem,
		ids: deps.ids,
		logger: deps.logger,
		processing: deps.processing,
		bucketForKind: () => deps.config.S3_BUCKET_PUBLIC,
		deleteUnpersistedObject: deps.uploadLifecycle.orphanDeletions.deleteOrQueue,
		uploadIntents: deps.uploadLifecycle.uploadIntents,
		...(deps.activeUploadTemps ? { activeUploadTemps: deps.activeUploadTemps } : {}),
	});
	const limits = (role: UserRole) => uploadLimits(deps.config, deps.settings, role);
	const submitService = createSubmitProjectService({
		webPublicUrl: deps.config.WEB_PUBLIC_URL,
		repository: deps.repository,
		logger: deps.logger,
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
		bucketForKind: () => deps.config.S3_BUCKET_PUBLIC,
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
			bodyLimit: Math.min(inlineMaxBytes, megabytes(2)),
		},
	});
	const assetController = createProjectAssetUploadController({
		service: assetService,
		access: deps.access,
		bodyLimit: inlineMaxBytes,
	});
	const meSubmit = createMeProjectController({
		service: submitService,
		route: {
			...route,
			bodyLimit: Math.min(inlineMaxBytes, megabytes(2)),
		},
	});

	return {
		projectMultipartController: createAdminProjectMultipartController({
			submitController: adminSubmit,
			assetController,
		}),
		meController: createMeRoutes({
			projectController: meSubmit,
			assetController,
		}),
		projectAccess: deps.access,
		projectRepository: deps.repository,
	};
}
