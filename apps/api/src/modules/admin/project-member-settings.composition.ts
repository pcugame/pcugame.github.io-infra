import type { FastifyPluginAsync } from 'fastify';
import type {
	AppLogger,
	Clock,
	ObjectStorage,
	SettingsStore,
} from '../../application/ports.js';
import type { Env } from '../../config/env.js';
import type { createProjectAccessService } from './project-access.service.js';
import { createMemberController } from './member/controller.js';
import type { MemberServiceDependencies } from './member/service.js';
import { createMemberService } from './member/service.js';
import { createProjectController } from './project/controller.js';
import type { ProjectApplicationRepository } from './project/ports.js';
import { createProjectSerializer } from './project/serializer.js';
import { createProjectService } from './project/service.js';
import { assertStatusTransition, bulkUpdateStatus } from './project/project-status.service.js';
import { createSettingsController } from './settings/controller.js';
import { createSettingsService } from './settings/service.js';
import type { UploadLifecycleRuntime } from '../upload-lifecycle/ports.js';

export interface ProjectMemberSettingsProductionGraph {
	projectController: FastifyPluginAsync;
	memberController: FastifyPluginAsync;
	settingsController: FastifyPluginAsync;
	/** Shared context-owned ports consumed by ticket-011 multipart controllers. */
	projectAccess: ReturnType<typeof createProjectAccessService>;
	projectRepository: ProjectApplicationRepository;
}

export interface ProjectMemberSettingsProductionDependencies {
	config: Pick<
		Env,
		| 'API_PUBLIC_URL'
		| 'PUBLIC_ASSET_BASE_URL'
		| 'S3_BUCKET_PUBLIC'
		| 'S3_BUCKET_PROTECTED'
		| 'UPLOAD_CHUNK_SIZE_MB'
	>;
	projectAccess: ReturnType<typeof createProjectAccessService>;
	projectExists(projectId: number): Promise<boolean>;
	projectRepository: ProjectApplicationRepository;
	memberRepository: MemberServiceDependencies['repository'];
	storage: ObjectStorage;
	settings: SettingsStore;
	logger: AppLogger;
	clock: Clock;
	uploadLifecycle: UploadLifecycleRuntime;
}

/** Compose the ticket-008 slice exclusively from one BackendContext's ports. */
export function createProjectMemberSettingsProductionGraph(
	deps: ProjectMemberSettingsProductionDependencies,
): ProjectMemberSettingsProductionGraph {
	const serializer = createProjectSerializer(
		deps.config.API_PUBLIC_URL,
		deps.config.PUBLIC_ASSET_BASE_URL,
	);
	const projectService = createProjectService({
		repository: deps.projectRepository,
		serializeProjectDetail: serializer.serializeProjectDetail,
		deletionBuckets: {
			publicBucket: deps.config.S3_BUCKET_PUBLIC,
			protectedBucket: deps.config.S3_BUCKET_PROTECTED,
		},
		abortMultipart: (key, uploadId) => (
			deps.storage.abortMultipart(deps.config.S3_BUCKET_PROTECTED, key, uploadId)
		),
		wakeDeletionWorker: deps.uploadLifecycle.wakeDeletionWorker,
		wakeMaintenance: deps.uploadLifecycle.wakeMaintenance,
		logger: deps.logger,
		recordPostCommitCleanupFailure:
			deps.uploadLifecycle.metrics.recordPostCommitCleanupFailure,
	});
	const memberService = createMemberService({
		projectExists: deps.projectExists,
		repository: deps.memberRepository,
	});
	const settingsService = createSettingsService({
		maxChunkSizeMb: Math.floor(deps.config.UPLOAD_CHUNK_SIZE_MB),
		repository: {
			getSettings: () => deps.settings.get(),
			patchSettings: (patch) => deps.settings.update(patch),
		},
	});

	return {
		projectAccess: deps.projectAccess,
		projectRepository: deps.projectRepository,
		projectController: createProjectController({
			service: projectService,
			access: deps.projectAccess,
			status: {
				assertTransition: assertStatusTransition,
				bulkUpdate: (ids, status) => bulkUpdateStatus(deps.projectRepository, ids, status),
			},
		}),
		memberController: createMemberController({ service: memberService, access: deps.projectAccess }),
		settingsController: createSettingsController({ service: settingsService }),
	};
}
