import { join } from 'node:path';
import type {
	AppLogger,
	FileSystem,
	IdGenerator,
	ObjectStorage,
} from '../../../application/ports.js';
import { badRequest } from '../../../shared/errors.js';
import { validateZipArchiveObject } from '../../assets/upload/zip-validation.js';
import type { UploadLifecycleRuntime } from '../../upload-lifecycle/ports.js';
import { createWebglDeployment } from '../../webgl/deployment.js';
import { webglUrl } from '../../webgl/paths.js';
import { createCompletedUploadFinalizer } from './finalize-completed-upload.service.js';
import { recordGameUploadEvent, safeGameUploadLogContext } from './observability.js';
import type { GameUploadSessionSummary } from './ports.js';
import { materializeAndValidateCompletedSource } from './source-identity.js';
import {
	createValidationWorker,
	type ValidationItemContext,
	type ValidationWorkerOptions,
} from './validation-worker.service.js';

export interface ValidationWorkerMetrics {
	recordBytesRead(bytes: number): void;
	recordDuration(durationMs: number): void;
	setActive(count: number): void;
	setTempBytes(bytes: number): void;
	bytesRead(): number;
	lastDurationMs(): number;
	active(): number;
	tempBytes(): number;
}

export function createValidationWorkerMetrics(): ValidationWorkerMetrics {
	let totalBytesRead = 0;
	let durationMs = 0;
	let active = 0;
	let tempBytes = 0;
	return {
		recordBytesRead(bytes) { totalBytesRead += bytes; },
		recordDuration(value) { durationMs = value; },
		setActive(value) { active = value; },
		setTempBytes(value) { tempBytes = value; },
		bytesRead: () => totalBytesRead,
		lastDurationMs: () => durationMs,
		active: () => active,
		tempBytes: () => tempBytes,
	};
}

export function createValidationTempDiskBudget(input: {
	maxBytes: number;
	onUsageChanged?(bytes: number): void;
}) {
	if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1) {
		throw new RangeError('Validation temp disk budget must be a positive safe integer');
	}
	let reservedBytes = 0;
	return {
		tryReserve(bytes: number): (() => void) | null {
			if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > input.maxBytes - reservedBytes) {
				return null;
			}
			reservedBytes += bytes;
			input.onUsageChanged?.(reservedBytes);
			let released = false;
			return () => {
				if (released) return;
				released = true;
				reservedBytes -= bytes;
				input.onUsageChanged?.(reservedBytes);
			};
		},
		usage: () => reservedBytes,
	};
}

export interface GameUploadValidationGraphOptions extends ValidationWorkerOptions {
	tempRoot: string;
	tempDiskBudgetBytes: number;
}

export interface GameUploadValidationGraphDependencies {
	config: {
		PUBLIC_ASSET_BASE_URL: string;
		S3_BUCKET_PUBLIC: string;
		S3_BUCKET_PROTECTED: string;
	};
	storage: Pick<ObjectStorage, 'stream' | 'upload'>;
	fileSystem: Pick<
		FileSystem,
		| 'createWriteStream'
		| 'readRange'
		| 'remove'
		| 'temporaryDirectory'
	>;
	ids: IdGenerator;
	logger: AppLogger;
	uploadLifecycle: UploadLifecycleRuntime;
	options: GameUploadValidationGraphOptions;
	metrics?: ValidationWorkerMetrics;
	/** Deterministic processing seam for bounded synthetic-stream tests. */
	materializeSource?: typeof materializeAndValidateCompletedSource;
}

/**
 * Processing-only composition. This graph is never imported by BackendContext
 * or Fastify; its protected object reader exists solely in validation-worker.
 */
export function createGameUploadValidationGraph(
	deps: GameUploadValidationGraphDependencies,
) {
	const metrics = deps.metrics ?? createValidationWorkerMetrics();
	const disk = createValidationTempDiskBudget({
		maxBytes: deps.options.tempDiskBudgetBytes,
		onUsageChanged: metrics.setTempBytes,
	});
	const repository = deps.uploadLifecycle.gameUploads;
	const webgl = createWebglDeployment({
		config: {
			publicBucket: deps.config.S3_BUCKET_PUBLIC,
			protectedBucket: deps.config.S3_BUCKET_PROTECTED,
		},
		storage: deps.storage,
		fileSystem: deps.fileSystem,
		ids: deps.ids,
		deletion: deps.uploadLifecycle.orphanDeletions,
		logger: deps.logger,
	});

	async function process(
		session: GameUploadSessionSummary,
		context: ValidationItemContext,
	): Promise<void> {
		const startedAt = Date.now();
		const storageKey = session.s3Key ?? session.storageKey;
		if (!storageKey) {
			throw new Error('VERIFYING session is missing its immutable storage key');
		}
		const size = Number(session.totalBytes);
		const releaseDisk = disk.tryReserve(size);
		if (!releaseDisk) {
			throw new Error('Validation temp disk budget is exhausted');
		}
		metrics.setActive(metrics.active() + 1);
		const tempId = deps.ids.next().replace(/[^a-zA-Z0-9-]/g, '');
		if (!tempId) {
			releaseDisk();
			metrics.setActive(metrics.active() - 1);
			throw new Error('Validation worker ID generator returned an unsafe value');
		}
		const archivePath = join(deps.options.tempRoot, `pcu-validation-${tempId}.zip`);
		try {
			await context.assertClaimOwned();
			const source = await deps.storage.stream(
				deps.config.S3_BUCKET_PROTECTED,
				storageKey,
				undefined,
				{ signal: context.signal },
			);
			if (!source) throw badRequest('Completed validation object was not found');
			if ('kind' in source) throw new Error(`Unexpected protected object stream outcome: ${source.kind}`);
			let bytesRead = 0;
			const materialized = await (deps.materializeSource ?? materializeAndValidateCompletedSource)({
				totalBytes: session.totalBytes,
				sourceIdentityAlgorithm: session.sourceIdentityAlgorithm,
				sourceIdentity: session.sourceIdentity,
				sourceIdentityBlockSizeBytes: session.sourceIdentityBlockSizeBytes,
				sourceIdentityBlockManifest: session.sourceIdentityBlockManifest,
				source: source.body,
				destination: deps.fileSystem.createWriteStream(archivePath),
				signal: context.signal,
				physicalByteLimit: size,
				onBytes(bytes) {
					bytesRead += bytes;
					metrics.recordBytesRead(bytes);
				},
			});
			await context.assertClaimOwned();
			recordGameUploadEvent(deps, 'verification_bytes_read', {
				projectId: session.projectId,
				sessionId: session.id,
				generation: session.multipartGeneration ?? 1,
				bytesRead,
				result: 'materialized',
			});

			const finalizer = createCompletedUploadFinalizer({
				readHeader: () => deps.fileSystem.readRange(archivePath, 0, 7),
				validateGameArchive: async (_key, objectSize) => {
					await validateZipArchiveObject(
						objectSize,
						(start, end) => deps.fileSystem.readRange(archivePath, start, end),
					);
				},
				reserveWebglDeployment: (completed) => repository.reserveWebglDeployment({
					sessionId: completed.id,
					completionClaimToken: completed.completionClaimToken,
					candidateDeploymentId: deps.ids.next(),
				}),
				deployWebgl: (projectId, key, deploymentId, objectSize, options) => webgl.deployArchive(
					projectId,
					key,
					deploymentId,
					archivePath,
					objectSize,
					options?.storageRequest,
					options?.assertClaimOwned,
				),
				rollbackWebglPublicDeployment: (keys, reason, options) => (
					webgl.rollbackPublicDeployment(keys, reason, options)
				),
				finalizeGame: (completed) => repository.finalizeCompletedSession(
					completed.id,
					completed.projectId,
					'GAME',
					{
						storageKey: completed.s3Key,
						originalName: completed.originalName,
						mimeType: 'application/zip',
						sizeBytes: completed.totalBytes,
						isPublic: false,
						completionClaimToken: completed.completionClaimToken,
					},
					{
						bucket: deps.config.S3_BUCKET_PROTECTED,
						reason: 'game-upload-replace-previous',
						playbackReason: 'game-upload-replace-previous-playback',
					},
				),
				finalizeWebgl: (completed, deployment) => repository.finalizeCompletedWebglSession(
					completed.id,
					completed.projectId,
					deployment.entryKey,
					completed.s3Key,
					{
						publicBucket: deps.config.S3_BUCKET_PUBLIC,
						protectedBucket: deps.config.S3_BUCKET_PROTECTED,
						reason: 'webgl-upload-replace-previous',
					},
					completed.completionClaimToken,
					{
						status: 'COMPLETED',
						sessionId: completed.id,
						generation: completed.generation ?? 1,
						sizeBytes: Number(completed.totalBytes),
						uploadKind: 'WEBGL',
						webglUrl: webglUrl(deps.config.PUBLIC_ASSET_BASE_URL, deployment.entryKey),
					},
				),
				wakeDeletionWorker: deps.uploadLifecycle.wakeDeletionWorker,
				webglUrl: (entryKey) => webglUrl(deps.config.PUBLIC_ASSET_BASE_URL, entryKey),
				logError: (contextValue, message) => deps.logger.error(
					safeGameUploadLogContext({
						...contextValue,
						action: 'finalize_completed_upload',
						result: 'cleanup_failed',
					}),
					message,
				),
			});
			await finalizer.finalize({
				id: session.id,
				projectId: session.projectId,
				uploadKind: session.uploadKind,
				originalName: session.originalName,
				totalBytes: session.totalBytes,
				s3Key: storageKey,
				completionClaimToken: context.claimToken,
				generation: session.multipartGeneration ?? 1,
				sourceIdentityAlgorithm: session.sourceIdentityAlgorithm,
				sourceIdentity: session.sourceIdentity,
				sourceIdentityBlockSizeBytes: session.sourceIdentityBlockSizeBytes,
				sourceIdentityBlockManifest: session.sourceIdentityBlockManifest,
			}, { size: materialized.bytesWritten }, {
				storageRequest: { signal: context.signal },
				assertClaimOwned: context.assertClaimOwned,
			});
		} finally {
			await deps.fileSystem.remove(archivePath).catch((error) => {
				deps.logger.warn(
					safeGameUploadLogContext({
						error,
						sessionId: session.id,
						projectId: session.projectId,
						action: 'remove_temp_archive',
						result: 'failed',
					}),
					'Failed to remove validation worker temp archive',
				);
			});
			releaseDisk();
			metrics.setActive(Math.max(0, metrics.active() - 1));
			const durationMs = Date.now() - startedAt;
			metrics.recordDuration(durationMs);
			recordGameUploadEvent(deps, 'verification_duration', {
				projectId: session.projectId,
				sessionId: session.id,
				generation: session.multipartGeneration ?? 1,
				durationMs,
				result: context.signal.aborted ? 'aborted' : 'finished',
			});
		}
	}

	return {
		metrics,
		disk,
		worker: createValidationWorker({
			repository,
			ids: deps.ids,
			processor: { process },
			wakeDeletionWorker: deps.uploadLifecycle.wakeDeletionWorker,
			logger: deps.logger,
			options: {
				concurrency: deps.options.concurrency,
				claimLeaseMs: deps.options.claimLeaseMs,
				...(deps.options.heartbeatMs !== undefined
					? { heartbeatMs: deps.options.heartbeatMs }
					: {}),
			},
		}),
	};
}
