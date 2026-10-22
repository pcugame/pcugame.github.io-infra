import { createPlaybackRepository } from './playback.repository.js';
import { createPlaybackWorker } from './playback.worker.js';
import type { ObjectStorage, AppLogger, IdGenerator } from '../../application/ports.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { createBoundedCommandRunner } from './command-runner.js';
import { createFfmpegVideoOperations } from './ffmpeg-operations.js';
import { cleanupStaleVideoWorkspaces } from './materialize.js';
import { DEFAULT_VIDEO_LIMITS, type VideoLimits } from './policy.js';
import { createVideoProcessor } from './processor.js';
import { createVideoWorkerRepository } from './repository.js';
import type { VideoWorkerStorage } from './ports.js';
import { createVideoProcessingWorker } from './worker.js';
import { WorkerSourceObjectMissingError } from '../upload-lifecycle/worker-errors.js';

function createVideoWorkerStorage(storage: ObjectStorage): VideoWorkerStorage {
	return {
		async stream(bucket, key, signal) {
			const result = await storage.stream(bucket, key, undefined, { signal });
			if (!result || 'kind' in result) {
				throw new WorkerSourceObjectMissingError('Canonical VIDEO source object does not exist');
			}
			return {
				body: result.body,
				size: result.size,
				...(result.etag ? { etag: result.etag } : {}),
			};
		},
		async head(bucket, key, signal) {
			const result = await storage.head(bucket, key, { signal });
			return result ? {
				size: result.size,
				...(result.etag ? { etag: result.etag } : {}),
				...(result.checksumSha256 ? { checksumSha256: result.checksumSha256 } : {}),
			} : null;
		},
		upload(input) {
			return storage.upload(
				input.bucket,
				input.key,
				input.body,
				input.contentType,
				input.contentLength,
				{ checksumSha256: input.checksumSha256 },
				{ signal: input.signal },
			);
		},
	};
}

export function createVideoWorkerGraph(input: {
	prisma: PrismaClient;
	storage: ObjectStorage;
	logger: AppLogger;
	ids: IdGenerator;
	protectedBucket: string;
	tempRoot: string;
	tempDiskBudgetBytes: number;
	limits?: VideoLimits;
	renditionsEnabled?: boolean;
	clock?: { now(): Date };
}) {
	const limits = input.limits ?? DEFAULT_VIDEO_LIMITS;
	const repository = createVideoWorkerRepository(input.prisma, input.renditionsEnabled);
	const processor = createVideoProcessor({
		repository,
		storage: createVideoWorkerStorage(input.storage),
		operations: createFfmpegVideoOperations(createBoundedCommandRunner(), limits),
		tempRoot: input.tempRoot,
		tempDiskBudgetBytes: input.tempDiskBudgetBytes,
		protectedBucket: input.protectedBucket,
		limits,
		clock: input.clock ?? { now: () => new Date() },
		logger: input.logger,
	});

    const originalWorker = createVideoProcessingWorker({ repository, processor, ids: input.ids, logger: input.logger, claimLimit: 1 });
    const playbackWorker = createPlaybackWorker({ repository: createPlaybackRepository(input.prisma),
        storage: createVideoWorkerStorage(input.storage), operations: createFfmpegVideoOperations(createBoundedCommandRunner(), limits),
        limits, tempRoot: input.tempRoot, tempDiskBudgetBytes: input.tempDiskBudgetBytes, logger: input.logger });
    return {
        repository,
		processor,
        worker: {
            async runPass(signal?: AbortSignal) {
                const uploads = await originalWorker.runPass(signal);
                if (!input.renditionsEnabled || signal?.aborted) return uploads;
                const jobs = await playbackWorker.runPass(signal);
                return { claimed: uploads.claimed + jobs.claimed, ready: uploads.ready + jobs.ready,
                    rejected: uploads.rejected + jobs.rejected, retried: uploads.retried + jobs.retried };
            },
        },
		cleanupStaleWorkspaces: (cutoff: Date) => cleanupStaleVideoWorkspaces(input.tempRoot, cutoff),
	};
}
