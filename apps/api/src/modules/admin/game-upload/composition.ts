import type { UserRole } from '@pcu/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type {
	AppLogger,
	Clock,
	FileSystem,
	IdGenerator,
	Lifecycle,
	ObjectStorage,
	SettingsStore,
	UploadLimiter,
} from '../../../application/ports.js';
import { createObjectDeletionCoordinator } from '../../../application/object-deletion.js';
import type { Env } from '../../../config/env.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import { storageOptionsForAsset } from '../../assets/upload/storage-policy.js';
import { validateZipArchiveObject } from '../../assets/upload/zip-validation.js';
import { createOrphanRepository } from '../../orphan/repository.js';
import { createOrphanService } from '../../orphan/service.js';
import { createWebglDeployment } from '../../webgl/deployment.js';
import { createWebglDeploymentKeys, webglUrl } from '../../webgl/paths.js';
import type { createProjectAccessService } from '../project-access.service.js';
import { createCompletedUploadFinalizer } from './finalize-completed-upload.service.js';
import { createGameUploadController } from './controller.js';
import { createGameUploadRepository } from './repository.js';
import { createGameUploadService } from './service.js';
import { chunkUploadBodyLimitBytes } from './session-sizing.js';

type GameUploadConfig = Pick<
	Env,
	| 'API_PUBLIC_URL'
	| 'S3_BUCKET_PUBLIC'
	| 'S3_BUCKET_PROTECTED'
	| 'UPLOAD_CHUNK_SIZE_MB'
	| 'UPLOAD_SESSION_TTL_MINUTES'
	| 'UPLOAD_USER_GAME_MAX_MB'
	| 'UPLOAD_PRIVILEGED_GAME_MAX_MB'
>;

type GameUploadService = ReturnType<typeof createGameUploadService>;

export interface GameUploadProductionDependencies {
	config: GameUploadConfig;
	prisma: PrismaClient;
	storage: ObjectStorage;
	fileSystem: FileSystem;
	settings: SettingsStore;
	uploadLimiter: UploadLimiter;
	lifecycle: Lifecycle;
	clock: Clock;
	ids: IdGenerator;
	logger: AppLogger;
	access: ReturnType<typeof createProjectAccessService>;
}

export interface GameUploadProductionGraph {
	controller: FastifyPluginAsync;
	service: GameUploadService;
	recoverStaleUploads(): Promise<void>;
	reapOrphans(): Promise<void>;
	close(): Promise<void>;
}

function megabytes(value: number): number {
	return value * 1024 * 1024;
}

function createWorkflowActivity() {
	const active = new Set<Promise<unknown>>();
	let closing = false;
	let closePromise: Promise<void> | undefined;

	function run<T>(work: () => Promise<T>): Promise<T> {
		if (closing) {
			return Promise.reject(new Error('Game upload workflow is closed'));
		}
		const operation = Promise.resolve().then(work);
		active.add(operation);
		void operation.then(
			() => active.delete(operation),
			() => active.delete(operation),
		);
		return operation;
	}

	return {
		run,
		close(): Promise<void> {
			closing = true;
			closePromise ??= Promise.allSettled([...active]).then(() => undefined);
			return closePromise;
		},
	};
}

/**
 * Compose game-upload, WebGL deployment, and orphan reconciliation exclusively
 * from resources owned by one BackendContext. Construction is I/O-free.
 */
export function createGameUploadProductionGraph(
	deps: GameUploadProductionDependencies,
): GameUploadProductionGraph {
	const repository = createGameUploadRepository(deps.prisma);
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
	const webgl = createWebglDeployment({
		config: {
			publicBucket: deps.config.S3_BUCKET_PUBLIC,
			protectedBucket: deps.config.S3_BUCKET_PROTECTED,
		},
		storage: deps.storage,
		fileSystem: deps.fileSystem,
		ids: deps.ids,
		deletion,
		logger: deps.logger,
	});
	const finalizer = createCompletedUploadFinalizer({
		readHeader: (key) => deps.storage.readRange(
			deps.config.S3_BUCKET_PROTECTED,
			key,
			0,
			7,
		),
		validateGameArchive: async (key, size) => {
			await validateZipArchiveObject(
				size,
				(start, end) => deps.storage.readRange(
					deps.config.S3_BUCKET_PROTECTED,
					key,
					start,
					end,
				),
			);
		},
		deployWebgl: webgl.deploySource,
		rollbackWebglPublicDeployment: webgl.rollbackPublicDeployment,
		finalizeGame: (session) => repository.finalizeCompletedSession(
			session.id,
			session.projectId,
			'GAME',
			{
				storageKey: session.s3Key,
				originalName: session.originalName,
				mimeType: 'application/zip',
				sizeBytes: session.totalBytes,
				isPublic: false,
			},
			{
				bucket: deps.config.S3_BUCKET_PROTECTED,
				reason: 'game-upload-replace-previous',
				playbackReason: 'game-upload-replace-previous-playback',
			},
		),
		finalizeWebgl: (session, deployment) => (
			repository.finalizeCompletedWebglSession(
				session.id,
				session.projectId,
				deployment.entryKey,
				session.s3Key,
				{
					publicBucket: deps.config.S3_BUCKET_PUBLIC,
					protectedBucket: deps.config.S3_BUCKET_PROTECTED,
					reason: 'webgl-upload-replace-previous',
				},
			)
		),
		deleteWebglDeploymentByEntry: webgl.deleteDurablyQueuedDeploymentByEntry,
		deleteOrQueue: (key, reason, context) => deletion.deleteOrQueue(
			deps.config.S3_BUCKET_PROTECTED,
			key,
			reason,
			context,
		),
		webglUrl: (projectId) => webglUrl(deps.config.API_PUBLIC_URL, projectId),
		logError: (context, message) => deps.logger.error(context, message),
	});
	const rawService = createGameUploadService({
		repository,
		storage: {
			createMultipart: (key) => deps.storage.createMultipart(
				deps.config.S3_BUCKET_PROTECTED,
				key,
				'application/zip',
				storageOptionsForAsset('GAME', 'original'),
			),
			abortMultipart: (key, uploadId) => deps.storage.abortMultipart(
				deps.config.S3_BUCKET_PROTECTED,
				key,
				uploadId,
			),
			uploadPart: (key, uploadId, partNumber, body, contentLength) => (
				deps.storage.uploadPart(
					deps.config.S3_BUCKET_PROTECTED,
					key,
					uploadId,
					partNumber,
					body,
					contentLength,
				)
			),
			completeMultipart: (key, uploadId, parts) => deps.storage.completeMultipart(
				deps.config.S3_BUCKET_PROTECTED,
				key,
				uploadId,
				parts,
			),
			head: (key) => deps.storage.head(deps.config.S3_BUCKET_PROTECTED, key),
		},
		finalizer,
		settings: deps.settings,
		uploadSlots: deps.uploadLimiter,
		clock: deps.clock,
		ids: deps.ids,
		lifecycle: deps.lifecycle,
		config: {
			uploadChunkSizeMb: deps.config.UPLOAD_CHUNK_SIZE_MB,
			uploadSessionTtlMinutes: deps.config.UPLOAD_SESSION_TTL_MINUTES,
		},
		roleGameMaxBytes: (role: UserRole) => megabytes(
			role === 'ADMIN' || role === 'OPERATOR'
				? deps.config.UPLOAD_PRIVILEGED_GAME_MAX_MB
				: deps.config.UPLOAD_USER_GAME_MAX_MB,
		),
		storageKey: (uploadKind, projectId) => {
			const id = deps.ids.next();
			return uploadKind === 'WEBGL'
				? createWebglDeploymentKeys(projectId, id).sourceKey
				: `${id}.zip`;
		},
		deleteOrQueue: (key, reason, context) => deletion.deleteOrQueue(
			deps.config.S3_BUCKET_PROTECTED,
			key,
			reason,
			context,
		),
		logger: deps.logger,
	});
	const activity = createWorkflowActivity();
	const service: GameUploadService = {
		createSession: (...args) => activity.run(() => rawService.createSession(...args)),
		uploadChunk: (...args) => activity.run(() => rawService.uploadChunk(...args)),
		completeSession: (...args) => activity.run(() => rawService.completeSession(...args)),
		cancelSession: (...args) => activity.run(() => rawService.cancelSession(...args)),
		getSessionStatus: (...args) => activity.run(() => rawService.getSessionStatus(...args)),
		listSessions: (...args) => activity.run(() => rawService.listSessions(...args)),
		sweepStaleCompletingSessions: () => activity.run(
			() => rawService.sweepStaleCompletingSessions(),
		),
	};
	let recoveryPromise: Promise<void> | undefined;

	return {
		controller: createGameUploadController({
			service,
			access: deps.access,
			chunkUploadBodyLimitBytes: chunkUploadBodyLimitBytes({
				UPLOAD_CHUNK_SIZE_MB: deps.config.UPLOAD_CHUNK_SIZE_MB,
			}),
		}),
		service,
		recoverStaleUploads() {
			recoveryPromise ??= service.sweepStaleCompletingSessions()
				.then(() => undefined)
				.catch((error) => {
					deps.logger.error(
						error,
						'Boot sweep for stale COMPLETING sessions failed — continuing',
					);
				});
			return recoveryPromise;
		},
		reapOrphans: () => activity.run(async () => {
			await orphanService.runOrphanReaper();
		}),
		close: () => activity.close(),
	};
}
