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
	clock?: { now(): Date };
}) {
	const limits = input.limits ?? DEFAULT_VIDEO_LIMITS;
	const repository = createVideoWorkerRepository(input.prisma);
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
	return {
		repository,
		processor,
		worker: createVideoProcessingWorker({
			repository,
			processor,
			ids: input.ids,
			logger: input.logger,
		}),
		cleanupStaleWorkspaces: (cutoff: Date) => cleanupStaleVideoWorkspaces(input.tempRoot, cutoff),
	};
}
