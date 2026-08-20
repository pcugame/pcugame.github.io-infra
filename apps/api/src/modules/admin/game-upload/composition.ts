import type { UserRole } from '@pcu/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type {
	AppLogger,
	Clock,
	IdGenerator,
	Lifecycle,
	ObjectStorage,
	SettingsStore,
	UploadLimiter,
} from '../../../application/ports.js';
import type { Env } from '../../../config/env.js';
import { storageOptionsForAsset } from '../../assets/upload/storage-policy.js';
import { createWebglDeploymentKeys } from '../../webgl/paths.js';
import type { createProjectAccessService } from '../project-access.service.js';
import { createGameUploadController } from './controller.js';
import { createGameUploadService } from './service.js';
import { resolveRoleGameMaxBytes } from '../../../shared/upload-policy.js';
import type { UploadLifecycleRuntime } from '../../upload-lifecycle/ports.js';
import { assertUploadAllowed } from '../upload-guard.js';

type GameUploadConfig = Pick<
	Env,
	| 'S3_BUCKET_PROTECTED'
	| 'UPLOAD_CHUNK_SIZE_MB'
	| 'UPLOAD_SESSION_TTL_MINUTES'
	| 'UPLOAD_PART_URL_BATCH_MAX'
	| 'UPLOAD_PART_URL_TTL_SEC'
	| 'UPLOAD_PART_URL_REFRESH_MAX'
	| 'UPLOAD_PART_URL_REFRESH_WINDOW_MS'
	| 'DIRECT_UPLOAD_ACTOR_ACTIVE_SESSION_MAX'
	| 'DIRECT_UPLOAD_PROJECT_ACTIVE_SESSION_MAX'
	| 'DIRECT_UPLOAD_ACTOR_OUTSTANDING_MAX_BYTES'
	| 'RATE_LIMIT_DIRECT_SESSION_CREATE_MAX'
	| 'RATE_LIMIT_DIRECT_SESSION_CREATE_WINDOW_MS'
	| 'RATE_LIMIT_DIRECT_PART_URL_MAX'
	| 'RATE_LIMIT_DIRECT_PART_URL_WINDOW_MS'
	| 'UPLOAD_USER_GAME_MAX_MB'
	| 'UPLOAD_PRIVILEGED_GAME_MAX_MB'
>;

type GameUploadService = ReturnType<typeof createGameUploadService>;

export interface GameUploadProductionDependencies {
	config: GameUploadConfig;
	storage: ObjectStorage;
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
	const rawService = createGameUploadService({
		repository,
		partSigner: {
			presignUploadPart: (key, uploadId, partNumber, expiresInSeconds, checksumSha256) => (
				presignUploadPart(
					deps.config.S3_BUCKET_PROTECTED,
					key,
					uploadId,
					partNumber,
					expiresInSeconds,
					checksumSha256,
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
		settings: deps.settings,
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
			uploadPartUrlRefreshMax: deps.config.UPLOAD_PART_URL_REFRESH_MAX,
			uploadPartUrlRefreshWindowMs: deps.config.UPLOAD_PART_URL_REFRESH_WINDOW_MS,
			directUploadQuota: {
				actorActiveSessions: deps.config.DIRECT_UPLOAD_ACTOR_ACTIVE_SESSION_MAX,
				projectActiveSessions: deps.config.DIRECT_UPLOAD_PROJECT_ACTIVE_SESSION_MAX,
				actorOutstandingBytes: BigInt(deps.config.DIRECT_UPLOAD_ACTOR_OUTSTANDING_MAX_BYTES),
			},
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
		recordUntrackedMultipartCleanupFailure:
			deps.uploadLifecycle.metrics.recordUntrackedMultipartCleanupFailure,
		recordPostCommitCleanupFailure:
			deps.uploadLifecycle.metrics.recordPostCommitCleanupFailure,
		logger: deps.logger,
	});
	const service: GameUploadService = {
		createSession: (...args) => activity.run(() => rawService.createSession(...args)),
		signPartUrls: (...args) => activity.run(() => rawService.signPartUrls(...args)),
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
		sweepUntrackedMultipartUploads: (signal?: AbortSignal) => activity.run(
			() => rawService.sweepUntrackedMultipartUploads(signal),
		),
	};
	let recoveryPromise: Promise<void> | undefined;

	return {
		controller: createGameUploadController({
			service,
			access: deps.access,
			rateLimit: {
				create: {
					max: deps.config.RATE_LIMIT_DIRECT_SESSION_CREATE_MAX,
					timeWindow: deps.config.RATE_LIMIT_DIRECT_SESSION_CREATE_WINDOW_MS,
				},
				partUrls: {
					max: deps.config.RATE_LIMIT_DIRECT_PART_URL_MAX,
					timeWindow: deps.config.RATE_LIMIT_DIRECT_PART_URL_WINDOW_MS,
				},
			},
		}),
		service,
		recoverStaleUploads(signal?: AbortSignal) {
			if (signal?.aborted) return Promise.resolve();
			if (!recoveryPromise) {
				const maintenanceWork: Promise<unknown>[] = [
					service.sweepStaleCompletingSessions(signal),
					service.sweepExpiredPendingSessions(signal),
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
