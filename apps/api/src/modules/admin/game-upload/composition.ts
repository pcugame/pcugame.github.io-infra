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
import { createObjectReferenceResolver } from '../../orphan/reference-resolver.js';
import { createWebglDeployment } from '../../webgl/deployment.js';
import { createWebglDeploymentKeys, webglUrl } from '../../webgl/paths.js';
import type { createProjectAccessService } from '../project-access.service.js';
import { createCompletedUploadFinalizer } from './finalize-completed-upload.service.js';
import { createGameUploadController } from './controller.js';
import { createGameUploadRepository } from './repository.js';
import { createGameUploadService } from './service.js';
import { chunkUploadBodyLimitBytes } from './session-sizing.js';
import { createMultipartAbortService } from '../../multipart-abort/service.js';
import { createMultipartAbortRepository } from '../../multipart-abort/repository.js';
import { createUploadIntentService } from '../../upload-intent/service.js';
import { createUploadIntentRepository } from '../../upload-intent/repository.js';
import { createIdempotencyService } from '../../idempotency/service.js';
import { createIdempotencyRepository } from '../../idempotency/repository.js';
import type { UploadLifecycleMetrics } from '../../../lib/upload-lifecycle-metrics.js';
import { resolveRoleGameMaxBytes } from '../../../shared/upload-policy.js';

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
	uploadLifecycleMetrics?: UploadLifecycleMetrics;
}

export interface GameUploadProductionGraph {
	controller: FastifyPluginAsync;
	service: GameUploadService;
	recoverStaleUploads(signal?: AbortSignal): Promise<void>;
	reapOrphans(signal?: AbortSignal): Promise<void>;
	close(): Promise<void>;
}

const MULTIPART_REQUEST_TIMEOUT_MS = 45 * 60 * 1000;

function multipartStorageRequest(
	request?: { signal?: AbortSignal },
	workflowSignal?: AbortSignal,
) {
	const signals = [request?.signal, workflowSignal].filter(
		(signal): signal is AbortSignal => signal !== undefined,
	);
	return {
		requestTimeoutMs: MULTIPART_REQUEST_TIMEOUT_MS,
		...(signals.length === 1 ? { signal: signals[0] } : {}),
		...(signals.length > 1 ? { signal: AbortSignal.any(signals) } : {}),
	};
}

function createWorkflowActivity() {
	const active = new Set<Promise<unknown>>();
	let closing = false;
	let closePromise: Promise<void> | undefined;
	const abortController = new AbortController();

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
		signal: abortController.signal,
		run,
		close(): Promise<void> {
			closing = true;
			abortController.abort(new Error('Game upload workflow is closing'));
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
	const prismaCapabilities = deps.prisma as unknown as Record<string, unknown>;
	const durableLifecycleEnabled = Boolean(
		prismaCapabilities['uploadIntent']
		&& prismaCapabilities['idempotencyOperation']
		&& prismaCapabilities['multipartAbortTask']
		&& prismaCapabilities['gameUploadPartClaim']
		&& typeof prismaCapabilities['$queryRaw'] === 'function',
	);
	const repository = createGameUploadRepository(deps.prisma, {
		abortBucket: deps.config.S3_BUCKET_PROTECTED,
		durabilityEnabled: durableLifecycleEnabled,
	});
	const multipartAborts = createMultipartAbortService({
		repository: createMultipartAbortRepository(deps.prisma),
		storage: deps.storage,
		clock: deps.clock,
		ids: deps.ids,
		logger: deps.logger,
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
	const orphanService = createOrphanService({
		clock: deps.clock,
		storage: deps.storage,
		repository: createOrphanRepository(deps.prisma, durableLifecycleEnabled),
		...(durableLifecycleEnabled ? { references: createObjectReferenceResolver(
			deps.prisma,
			{
				publicBucket: deps.config.S3_BUCKET_PUBLIC,
				protectedBucket: deps.config.S3_BUCKET_PROTECTED,
			},
			deps.logger,
		) } : {}),
		ids: deps.ids,
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
	const activity = createWorkflowActivity();
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
		storageRequest: multipartStorageRequest(undefined, activity.signal),
	});
	const finalizer = createCompletedUploadFinalizer({
		readHeader: (key, request) => deps.storage.readRange(
			deps.config.S3_BUCKET_PROTECTED,
			key,
			0,
			7,
			multipartStorageRequest(request, activity.signal),
		),
		validateGameArchive: async (key, size, request) => {
			await validateZipArchiveObject(
				size,
				(start, end) => deps.storage.readRange(
					deps.config.S3_BUCKET_PROTECTED,
					key,
					start,
					end,
					multipartStorageRequest(request, activity.signal),
				),
			);
		},
		deployWebgl: (projectId, key, size, options) => webgl.deploySource(
			projectId,
			key,
			size,
			options?.storageRequest,
			options?.assertClaimOwned,
		),
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
				completionClaimToken: session.completionClaimToken,
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
				session.completionClaimToken,
				{
					status: 'COMPLETED',
					storageKey: session.s3Key,
					sizeBytes: Number(session.totalBytes),
					webglUrl: webglUrl(deps.config.API_PUBLIC_URL, session.projectId),
				},
			)
		),
		deleteWebglDeploymentByEntry: webgl.deleteDurablyQueuedDeploymentByEntry,
		deleteOrQueue: (key, reason, context) => deletion.deleteDurablyQueued(
			deps.config.S3_BUCKET_PROTECTED,
			key,
			reason,
			context,
		),
		webglUrl: (projectId) => webglUrl(deps.config.API_PUBLIC_URL, projectId),
		logError: (context, message) => deps.logger.error(context, message),
		...(deps.uploadLifecycleMetrics ? {
			recordPostCommitCleanupFailure:
				deps.uploadLifecycleMetrics.recordPostCommitCleanupFailure,
		} : {}),
	});
	const rawService = createGameUploadService({
		repository,
		storage: {
			createMultipart: (key, request) => deps.storage.createMultipart(
				deps.config.S3_BUCKET_PROTECTED,
				key,
				'application/zip',
				storageOptionsForAsset('GAME', 'original'),
				multipartStorageRequest(request, activity.signal),
			),
			abortMultipart: (key, uploadId, request) => deps.storage.abortMultipart(
				deps.config.S3_BUCKET_PROTECTED,
				key,
				uploadId,
				multipartStorageRequest(request, activity.signal),
			),
			uploadPart: (key, uploadId, partNumber, body, contentLength, request) => (
				deps.storage.uploadPart(
					deps.config.S3_BUCKET_PROTECTED,
					key,
					uploadId,
					partNumber,
					body,
					contentLength,
					multipartStorageRequest(request, activity.signal),
				)
			),
			completeMultipart: (key, uploadId, parts, request) => deps.storage.completeMultipart(
				deps.config.S3_BUCKET_PROTECTED,
				key,
				uploadId,
				parts,
				multipartStorageRequest(request, activity.signal),
			),
			...(deps.storage.listParts ? {
				listParts: (key: string, uploadId: string, request?: { signal?: AbortSignal }) => deps.storage.listParts!(
					deps.config.S3_BUCKET_PROTECTED,
					key,
					uploadId,
					multipartStorageRequest(request, activity.signal),
				),
			} : {}),
			...(deps.storage.listMultipartUploads ? {
				listMultipartUploads: (prefix: string, request?: { signal?: AbortSignal }) => deps.storage.listMultipartUploads!(
					deps.config.S3_BUCKET_PROTECTED,
					prefix,
					multipartStorageRequest(request, activity.signal),
				),
			} : {}),
			head: (key, request) => deps.storage.head(
				deps.config.S3_BUCKET_PROTECTED,
				key,
				multipartStorageRequest(request, activity.signal),
			),
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
		roleGameMaxBytes: (role: UserRole) => resolveRoleGameMaxBytes(deps.config, role),
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
		deleteDurablyQueued: (key, reason, context) => deletion.deleteDurablyQueued(
			deps.config.S3_BUCKET_PROTECTED,
			key,
			reason,
			context,
		),
		...(deps.uploadLifecycleMetrics ? {
			recordPostCommitCleanupFailure:
				deps.uploadLifecycleMetrics.recordPostCommitCleanupFailure,
		} : {}),
		logger: deps.logger,
	});
	const service: GameUploadService = {
		createSession: (...args) => activity.run(() => rawService.createSession(...args)),
		uploadChunk: (...args) => activity.run(() => rawService.uploadChunk(...args)),
		completeSession: (...args) => activity.run(() => rawService.completeSession(...args)),
		cancelSession: (...args) => activity.run(() => rawService.cancelSession(...args)),
		getSessionStatus: (...args) => activity.run(() => rawService.getSessionStatus(...args)),
		listSessions: (...args) => activity.run(() => rawService.listSessions(...args)),
		sweepStaleCompletingSessions: (signal?: AbortSignal) => activity.run(
			() => rawService.sweepStaleCompletingSessions(signal),
		),
		sweepExpiredPendingSessions: (signal?: AbortSignal) => activity.run(
			() => rawService.sweepExpiredPendingSessions(signal),
		),
		sweepExpiredPartClaims: (signal?: AbortSignal) => activity.run(
			() => rawService.sweepExpiredPartClaims(signal),
		),
		sweepUntrackedMultipartUploads: (signal?: AbortSignal) => activity.run(
			() => rawService.sweepUntrackedMultipartUploads(signal),
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
		recoverStaleUploads(signal?: AbortSignal) {
			if (signal?.aborted) return Promise.resolve();
			if (!recoveryPromise) {
				const maintenanceWork: Promise<unknown>[] = [
					service.sweepStaleCompletingSessions(signal),
					service.sweepExpiredPendingSessions(signal),
					service.sweepExpiredPartClaims(signal),
					service.sweepUntrackedMultipartUploads(signal),
				];
				if (durableLifecycleEnabled) {
					maintenanceWork.push(
						multipartAborts.run(signal),
						uploadIntents.sweep(signal),
						idempotency.purgeExpired(deps.clock.now()),
					);
				}
				recoveryPromise = Promise.allSettled(maintenanceWork).then((results) => {
					for (const result of results) {
						if (result.status === 'rejected') throw result.reason;
					}
				})
				.catch((error) => {
					deps.logger.error(
						error,
						'Upload lifecycle maintenance iteration failed — continuing',
					);
				})
				.finally(() => {
					recoveryPromise = undefined;
				});
			}
			return recoveryPromise;
		},
		reapOrphans: (signal?: AbortSignal) => activity.run(async () => {
			await orphanService.runOrphanReaper(signal);
		}),
		close: () => activity.close(),
	};
}
