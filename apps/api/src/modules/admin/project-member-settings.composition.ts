import type { FastifyPluginAsync } from 'fastify';
import type { AssetKind } from '@pcu/contracts';
import type {
	AppLogger,
	Clock,
	ObjectStorage,
	SettingsStore,
} from '../../application/ports.js';
import type { Env } from '../../config/env.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { createObjectDeletionCoordinator } from '../../application/object-deletion.js';
import { createOrphanRepository } from '../orphan/repository.js';
import { createOrphanService } from '../orphan/service.js';
import { createObjectReferenceResolver } from '../orphan/reference-resolver.js';
import { parseWebglEntryKey } from '../webgl/paths.js';
import { createProjectAccessRepository } from './project-access.repository.js';
import { createProjectAccessService } from './project-access.service.js';
import { createMemberController } from './member/controller.js';
import { createMemberRepository } from './member/repository.js';
import { createMemberService } from './member/service.js';
import { createProjectController } from './project/controller.js';
import { createProjectCrudRepository } from './project/crud.repository.js';
import { createProjectSerializer } from './project/serializer.js';
import { createProjectService } from './project/service.js';
import { assertStatusTransition, bulkUpdateStatus } from './project/project-status.service.js';
import { createSettingsController } from './settings/controller.js';
import { createSettingsService } from './settings/service.js';
import type { UploadLifecycleMetrics } from '../../lib/upload-lifecycle-metrics.js';
import { bucketForAssetKind } from '../../shared/upload-policy.js';

export interface ProjectMemberSettingsProductionGraph {
	projectController: FastifyPluginAsync;
	memberController: FastifyPluginAsync;
	settingsController: FastifyPluginAsync;
	/** Shared context-owned ports consumed by ticket-011 multipart controllers. */
	projectAccess: ReturnType<typeof createProjectAccessService>;
	projectRepository: ReturnType<typeof createProjectCrudRepository>;
}

export interface ProjectMemberSettingsProductionDependencies {
	config: Pick<
		Env,
		| 'API_PUBLIC_URL'
		| 'S3_BUCKET_PUBLIC'
		| 'S3_BUCKET_PROTECTED'
		| 'UPLOAD_CHUNK_SIZE_MB'
	>;
	prisma: PrismaClient;
	storage: ObjectStorage;
	settings: SettingsStore;
	logger: AppLogger;
	clock: Clock;
	uploadLifecycleMetrics?: UploadLifecycleMetrics;
}

function bucketForKind(
	kind: AssetKind,
	config: Pick<Env, 'S3_BUCKET_PUBLIC' | 'S3_BUCKET_PROTECTED'>,
): string {
	return bucketForAssetKind(kind, {
		publicBucket: config.S3_BUCKET_PUBLIC,
		protectedBucket: config.S3_BUCKET_PROTECTED,
	});
}

/** Compose the ticket-008 slice exclusively from one BackendContext's ports. */
export function createProjectMemberSettingsProductionGraph(
	deps: ProjectMemberSettingsProductionDependencies,
): ProjectMemberSettingsProductionGraph {
	const prismaCapabilities = deps.prisma as unknown as Record<string, unknown>;
	const durableLifecycleEnabled = Boolean(
		prismaCapabilities['uploadIntent']
		&& prismaCapabilities['orphanObject']
		&& typeof prismaCapabilities['$queryRaw'] === 'function',
	);
	const accessRepository = createProjectAccessRepository(deps.prisma);
	const access = createProjectAccessService(accessRepository);
	const repository = createProjectCrudRepository(deps.prisma);
	const orphanService = createOrphanService({
		clock: deps.clock,
		storage: deps.storage,
		repository: createOrphanRepository(deps.prisma),
		...(durableLifecycleEnabled ? {
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
		...(durableLifecycleEnabled ? {
			reapDurablyQueued: () => orphanService.runOrphanReaper(),
		} : {}),
	});
	const serializer = createProjectSerializer(deps.config.API_PUBLIC_URL);
	const projectService = createProjectService({
		repository,
		serializeProjectDetail: serializer.serializeProjectDetail,
		deletionBuckets: {
			publicBucket: deps.config.S3_BUCKET_PUBLIC,
			protectedBucket: deps.config.S3_BUCKET_PROTECTED,
		},
		async deleteAssetObjects(asset, reason) {
			const bucket = bucketForKind(asset.kind, deps.config);
			await deletion.deleteDurablyQueued(bucket, asset.storageKey, reason, {
				assetId: asset.id,
				projectId: asset.projectId,
			});
			if (asset.playbackStorageKey && asset.playbackStorageKey !== asset.storageKey) {
				await deletion.deleteDurablyQueued(
					bucket,
					asset.playbackStorageKey,
					`${reason}-playback`,
					{ assetId: asset.id, projectId: asset.projectId },
				);
			}
		},
		abortMultipart: (key, uploadId) => (
			deps.storage.abortMultipart(deps.config.S3_BUCKET_PROTECTED, key, uploadId)
		),
		async deleteWebglDeploymentByEntry(projectId, entryKey, reason) {
			const keys = parseWebglEntryKey(projectId, entryKey);
			if (!keys) {
				deps.logger.error(
					{ projectId, entryKey, reason },
					'Refusing to delete malformed WebGL entry key',
				);
				throw new Error(`Malformed WebGL entry key for project ${projectId}`);
			}
			await Promise.all([
				deletion.deleteDurablyQueued(
					deps.config.S3_BUCKET_PROTECTED,
					keys.sourceKey,
					`${reason}-source`,
					{ projectId, deploymentId: keys.deploymentId },
				),
				deletion.deleteDurablyQueuedPrefix(
					deps.config.S3_BUCKET_PUBLIC,
					keys.sitePrefix,
					`${reason}-site`,
					{ projectId, deploymentId: keys.deploymentId },
				),
			]);
		},
		async deleteWebglDeployment(keys, reason) {
			await Promise.all([
				deletion.deleteDurablyQueued(
					deps.config.S3_BUCKET_PROTECTED,
					keys.sourceKey,
					`${reason}-source`,
					{ projectId: keys.projectId, deploymentId: keys.deploymentId },
				),
				deletion.deleteDurablyQueuedPrefix(
					deps.config.S3_BUCKET_PUBLIC,
					keys.sitePrefix,
					`${reason}-site`,
					{ projectId: keys.projectId, deploymentId: keys.deploymentId },
				),
			]);
		},
		deleteQueuedProtectedObject: (key, reason, context) => (
			deletion.deleteDurablyQueued(deps.config.S3_BUCKET_PROTECTED, key, reason, context)
		),
		logger: deps.logger,
		...(deps.uploadLifecycleMetrics ? {
			recordPostCommitCleanupFailure:
				deps.uploadLifecycleMetrics.recordPostCommitCleanupFailure,
		} : {}),
	});
	const memberService = createMemberService({
		projectExists: async (projectId) => await accessRepository.findProject(projectId) !== null,
		repository: createMemberRepository(deps.prisma),
	});
	const settingsService = createSettingsService({
		maxChunkSizeMb: Math.floor(deps.config.UPLOAD_CHUNK_SIZE_MB),
		repository: {
			getSettings: () => deps.settings.get(),
			patchSettings: (patch) => deps.settings.update(patch),
		},
	});

	return {
		projectAccess: access,
		projectRepository: repository,
		projectController: createProjectController({
			service: projectService,
			access,
			status: {
				assertTransition: assertStatusTransition,
				bulkUpdate: (ids, status) => bulkUpdateStatus(repository, ids, status),
			},
		}),
		memberController: createMemberController({ service: memberService, access }),
		settingsController: createSettingsController({ service: settingsService }),
	};
}
