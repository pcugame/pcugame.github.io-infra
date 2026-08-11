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
import { createObjectDeletionCoordinator } from '../../application/object-deletion.js';
import type { Env } from '../../config/env.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import {
	bucketForAssetKind,
	megabytes,
	resolveRoleUploadLimits,
	type UploadLimits,
} from '../../shared/upload-policy.js';
import { createOrphanRepository } from '../orphan/repository.js';
import { createOrphanService } from '../orphan/service.js';
import { createObjectReferenceResolver } from '../orphan/reference-resolver.js';
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
import type { createProjectCrudRepository } from './project/crud.repository.js';
import type { MultipartRequestHasher } from '../../application/upload-ports.js';
import { createMultipartCollector } from '../assets/upload/multipart-collector.js';
import { createMeProjectController } from '../me/project/controller.js';
import { createMeRoutes } from '../me/me.routes.js';
import { createUploadIntentService } from '../upload-intent/service.js';
import { createUploadIntentRepository } from '../upload-intent/repository.js';
import { createIdempotencyService } from '../idempotency/service.js';
import { createIdempotencyRepository } from '../idempotency/repository.js';
import type { UploadLifecycleMetrics } from '../../lib/upload-lifecycle-metrics.js';

type ProjectMultipartConfig = Pick<
	Env,
	| 'API_PUBLIC_URL'
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
	projectRepository: ReturnType<typeof createProjectCrudRepository>;
}

export interface ProjectMultipartProductionDependencies {
	config: ProjectMultipartConfig;
	prisma: PrismaClient;
	storage: ObjectStorage;
	fileSystem: FileSystem;
	settings: SettingsStore;
	uploadLimiter: UploadLimiter;
	logger: AppLogger;
	clock: Clock;
	ids: IdGenerator;
	processing: ProjectUploadProcessing;
	requestHasher?: MultipartRequestHasher;
	access: ReturnType<typeof createProjectAccessService>;
	repository: ReturnType<typeof createProjectCrudRepository>;
	uploadLifecycleMetrics?: UploadLifecycleMetrics;
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

function assetUrl(
	baseUrl: string,
	storageKey: string,
	kind: AssetKind,
): string {
	const base = baseUrl.replace(/\/$/, '');
	return kind === 'GAME' || kind === 'VIDEO'
		? `${base}/api/assets/protected/${storageKey}`
		: `${base}/api/assets/public/${storageKey}`;
}

/** Compose ticket-011 exclusively from resources and ports owned by one context. */
export function createProjectMultipartProductionGraph(
	deps: ProjectMultipartProductionDependencies,
): ProjectMultipartProductionGraph {
	const prismaCapabilities = deps.prisma as unknown as Record<string, unknown>;
	const durableUploadsEnabled = Boolean(
		prismaCapabilities['uploadIntent']
		&& prismaCapabilities['idempotencyOperation']
		&& prismaCapabilities['orphanObject']
		&& typeof prismaCapabilities['$queryRaw'] === 'function',
	);
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
	const idempotency = createIdempotencyService({
		repository: createIdempotencyRepository(deps.prisma),
		clock: deps.clock,
		ids: deps.ids,
	});
	const requestHasher = deps.requestHasher;
	const createPipeline = () => createProjectUploadPipeline({
		storage: deps.storage,
		fileSystem: deps.fileSystem,
		ids: deps.ids,
		logger: deps.logger,
		processing: deps.processing,
		bucketForKind: (kind) => bucketForKind(kind, deps.config),
		deleteUnpersistedObject: deletion.deleteOrQueue,
		...(durableUploadsEnabled ? { uploadIntents } : {}),
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
		...(deps.uploadLifecycleMetrics ? {
			recordPostCommitCleanupFailure:
				deps.uploadLifecycleMetrics.recordPostCommitCleanupFailure,
		} : {}),
		...(requestHasher ? { requestHasher } : {}),
		...(durableUploadsEnabled ? { idempotency } : {}),
	});
	const assetService = createProjectAssetService({
		repository: deps.repository,
		uploadLimits: limits,
		uploadSlots: deps.uploadLimiter,
		uploadCoordinator: createProjectAssetUploadCoordinator({
			fileSystem: deps.fileSystem,
			ids: deps.ids,
			createPipeline,
			...(requestHasher ? { requestHasher } : {}),
		}),
		assetUrl: (storageKey, kind) => assetUrl(
			deps.config.API_PUBLIC_URL,
			storageKey,
			kind,
		),
		bucketForKind: (kind) => bucketForKind(kind, deps.config),
		deleteOrQueue: deletion.deleteDurablyQueued,
		logger: deps.logger,
		...(deps.uploadLifecycleMetrics ? {
			recordPostCommitCleanupFailure:
				deps.uploadLifecycleMetrics.recordPostCommitCleanupFailure,
		} : {}),
		...(durableUploadsEnabled ? { idempotency } : {}),
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
