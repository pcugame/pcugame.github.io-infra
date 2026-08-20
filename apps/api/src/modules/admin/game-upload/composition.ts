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
import type { Env } from '../../../config/env.js';
import { storageOptionsForAsset } from '../../assets/upload/storage-policy.js';
import { validateZipArchiveObject } from '../../assets/upload/zip-validation.js';
import { createWebglDeployment } from '../../webgl/deployment.js';
import { createWebglDeploymentKeys, webglUrl } from '../../webgl/paths.js';
import type { createProjectAccessService } from '../project-access.service.js';
import { createCompletedUploadFinalizer } from './finalize-completed-upload.service.js';
import { createGameUploadController } from './controller.js';
import { createGameUploadService } from './service.js';
import { chunkUploadBodyLimitBytes } from './session-sizing.js';
import { resolveRoleGameMaxBytes } from '../../../shared/upload-policy.js';
import type { UploadLifecycleRuntime } from '../../upload-lifecycle/ports.js';
import { assertUploadAllowed } from '../upload-guard.js';
import { validateCompletedSourceIdentity } from './source-identity.js';

type GameUploadConfig = Pick<
	Env,
	| 'API_PUBLIC_URL'
	| 'S3_BUCKET_PUBLIC'
	| 'S3_BUCKET_PROTECTED'
	| 'UPLOAD_CHUNK_SIZE_MB'
	| 'UPLOAD_SESSION_TTL_MINUTES'
	| 'UPLOAD_PART_URL_BATCH_MAX'
	| 'UPLOAD_PART_URL_TTL_SEC'
	| 'UPLOAD_USER_GAME_MAX_MB'
	| 'UPLOAD_PRIVILEGED_GAME_MAX_MB'
>;

type GameUploadService = ReturnType<typeof createGameUploadService>;

export interface GameUploadProductionDependencies {
	config: GameUploadConfig;
	storage: ObjectStorage;
	fileSystem: FileSystem;
	settings: SettingsStore;
	uploadLimiter: UploadLimiter;
	lifecycle: Lifecycle;
	clock: Clock;
	ids: IdGenerator;
	logger: AppLogger;
	access: ReturnType<typeof createProjectAccessService>;
	uploadLifecycle: UploadLifecycleRuntime;
}

export interface GameUploadProductionGraph {
	controller: FastifyPluginAsync;
	service: GameUploadService;
	recoverStaleUploads(signal?: AbortSignal): Promise<void>;
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
	const presignUploadPart = deps.storage.presignUploadPart;
	if (!presignUploadPart) {
		throw new Error('Game upload direct transport requires an UploadPart signer');
	}
	const repository = deps.uploadLifecycle.gameUploads;
	const deletion = deps.uploadLifecycle.orphanDeletions;
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
		validateSourceIdentity: (session, options) => validateCompletedSourceIdentity({
			totalBytes: session.totalBytes,
			sourceIdentityAlgorithm: session.sourceIdentityAlgorithm,
			sourceIdentity: session.sourceIdentity,
			sourceIdentityBlockSizeBytes: session.sourceIdentityBlockSizeBytes,
			sourceIdentityBlockManifest: session.sourceIdentityBlockManifest,
			readRange: (start, end) => deps.storage.readRange(
				deps.config.S3_BUCKET_PROTECTED,
				session.s3Key,
				start,
				end,
				multipartStorageRequest(options.storageRequest, activity.signal),
			),
			assertClaimOwned: options.assertClaimOwned,
		}),
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
		rollbackWebglPublicDeployment: (keys, reason, options) => (
			webgl.rollbackPublicDeployment(keys, reason, options)
		),
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
		wakeDeletionWorker: deps.uploadLifecycle.wakeDeletionWorker,
		webglUrl: (projectId) => webglUrl(deps.config.API_PUBLIC_URL, projectId),
		logError: (context, message) => deps.logger.error(context, message),
	});
	let rawService: ReturnType<typeof createGameUploadService>;
	let validationPending = false;
	let validationScheduled = false;
	function wakeValidationWorker(): void {
		validationPending = true;
		if (validationScheduled) return;
		validationScheduled = true;
		queueMicrotask(() => {
			validationScheduled = false;
			if (!validationPending) return;
			validationPending = false;
			void activity.run(() => rawService.sweepVerifyingSessions()).catch((error) => {
				deps.logger.error({ error }, 'Context-owned upload validation worker failed');
			});
		});
	}
	rawService = createGameUploadService({
		repository,
		partSigner: {
			presignUploadPart: (key, uploadId, partNumber, expiresInSeconds) => (
				presignUploadPart(
					deps.config.S3_BUCKET_PROTECTED,
					key,
					uploadId,
					partNumber,
					expiresInSeconds,
				)
			),
		},
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
			listParts: (key: string, uploadId: string, request?: { signal?: AbortSignal }) => deps.storage.listParts(
				deps.config.S3_BUCKET_PROTECTED,
				key,
				uploadId,
				multipartStorageRequest(request, activity.signal),
			),
			listMultipartUploads: (prefix: string, request?: { signal?: AbortSignal }) => deps.storage.listMultipartUploads(
				deps.config.S3_BUCKET_PROTECTED,
				prefix,
				multipartStorageRequest(request, activity.signal),
			),
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
		authorizeProjectWrite: async (actor, projectId) => {
			const project = await deps.access.loadProjectWithAccess(actor, projectId);
			const exhibition = await repository.findExhibitionById(project.exhibitionId);
			assertUploadAllowed(exhibition, project.exhibitionId, actor.role);
		},
		config: {
			uploadChunkSizeMb: deps.config.UPLOAD_CHUNK_SIZE_MB,
			uploadSessionTtlMinutes: deps.config.UPLOAD_SESSION_TTL_MINUTES,
			uploadPartUrlBatchMax: deps.config.UPLOAD_PART_URL_BATCH_MAX,
			uploadPartUrlTtlSeconds: deps.config.UPLOAD_PART_URL_TTL_SEC,
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
		wakeDeletionWorker: deps.uploadLifecycle.wakeDeletionWorker,
		wakeMaintenance: deps.uploadLifecycle.wakeMaintenance,
		wakeValidationWorker,
		recordUntrackedMultipartCleanupFailure:
			deps.uploadLifecycle.metrics.recordUntrackedMultipartCleanupFailure,
		recordPostCommitCleanupFailure:
			deps.uploadLifecycle.metrics.recordPostCommitCleanupFailure,
		logger: deps.logger,
	});
	const service: GameUploadService = {
		createSession: (...args) => activity.run(() => rawService.createSession(...args)),
		uploadChunk: (...args) => activity.run(() => rawService.uploadChunk(...args)),
		authorizeLegacyChunkUpload: (...args) => activity.run(
			() => rawService.authorizeLegacyChunkUpload(...args),
		),
		signPartUrls: (...args) => activity.run(() => rawService.signPartUrls(...args)),
		completeSession: (...args) => activity.run(() => rawService.completeSession(...args)),
		cancelSession: (...args) => activity.run(() => rawService.cancelSession(...args)),
		getSessionStatus: (...args) => activity.run(() => rawService.getSessionStatus(...args)),
		listSessions: (...args) => activity.run(() => rawService.listSessions(...args)),
		sweepStaleCompletingSessions: (signal?: AbortSignal) => activity.run(
			() => rawService.sweepStaleCompletingSessions(signal),
		),
		sweepVerifyingSessions: (signal?: AbortSignal) => activity.run(
			() => rawService.sweepVerifyingSessions(signal),
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
					service.sweepVerifyingSessions(signal),
					service.sweepExpiredPendingSessions(signal),
					service.sweepExpiredPartClaims(signal),
					service.sweepUntrackedMultipartUploads(signal),
				];
				recoveryPromise = Promise.allSettled(maintenanceWork).then((results) => {
					const failures = results.flatMap((result) => (
						result.status === 'rejected' ? [result.reason] : []
					));
					if (failures.length > 0) {
						throw new AggregateError(failures, 'Game upload maintenance iteration failed');
					}
				})
				.finally(() => {
					recoveryPromise = undefined;
				});
			}
			return recoveryPromise;
		},
		close: () => activity.close(),
	};
}
