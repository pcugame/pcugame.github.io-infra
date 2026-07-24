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
import { createOrphanRepository } from '../../orphan/repository.js';
import { createOrphanService } from '../../orphan/service.js';
import { createYearController } from './controller.js';
import { createExhibitionPosterUploadCoordinator } from './poster-upload.adapter.js';
import { createExhibitionRepository } from './repository.js';
import { createExhibitionService } from './service.js';

type YearConfig = Pick<
	Env,
	| 'API_PUBLIC_URL'
	| 'S3_BUCKET_PUBLIC'
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
}

function megabytes(value: number): number {
	return value * 1024 * 1024;
}

function uploadLimits(config: YearConfig, role: UserRole): UploadLimits {
	const privileged = role === 'ADMIN' || role === 'OPERATOR';
	return privileged
		? {
			posterMaxBytes: megabytes(config.UPLOAD_PRIVILEGED_IMAGE_MAX_MB),
			imageMaxBytes: megabytes(config.UPLOAD_PRIVILEGED_IMAGE_MAX_MB),
			gameMaxBytes: megabytes(config.UPLOAD_PRIVILEGED_GAME_MAX_MB),
			videoMaxBytes: 1024 * 1024 * 1024,
			requestMaxBytes: megabytes(config.UPLOAD_PRIVILEGED_REQUEST_MAX_MB),
			maxFiles: config.UPLOAD_PRIVILEGED_MAX_FILES,
		}
		: {
			posterMaxBytes: megabytes(config.UPLOAD_USER_IMAGE_MAX_MB),
			imageMaxBytes: megabytes(config.UPLOAD_USER_IMAGE_MAX_MB),
			gameMaxBytes: megabytes(config.UPLOAD_USER_GAME_MAX_MB),
			videoMaxBytes: 200 * 1024 * 1024,
			requestMaxBytes: megabytes(config.UPLOAD_USER_REQUEST_MAX_MB),
			maxFiles: config.UPLOAD_USER_MAX_FILES,
		};
}

/** Compose ticket-009 solely from resources owned by one BackendContext. */
export function createYearProductionGraph(
	deps: YearProductionDependencies,
): YearProductionGraph {
	const repository = createExhibitionRepository(deps.prisma);
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
	});
	const service = createExhibitionService({
		apiPublicUrl: deps.config.API_PUBLIC_URL,
		posterBucket: deps.config.S3_BUCKET_PUBLIC,
		repository,
		uploadLimits: (role) => uploadLimits(deps.config, role),
		uploadSlots: deps.uploadLimiter,
		posterUpload,
		deleteOrQueue: deletion.deleteDurablyQueued,
	});

	// Site settings is part of the same context-owned slice. It currently has no
	// exhibition-specific field; retaining it here prevents a future runtime
	// singleton reach-back when the upload policy grows.
	void deps.settings;

	return {
		exhibitionController: createYearController({
			service,
			uploadBodyLimit: megabytes(deps.config.UPLOAD_PRIVILEGED_REQUEST_MAX_MB),
		}),
	};
}
