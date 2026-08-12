import type { AssetKind } from '../src/generated/prisma/client.js';
import type { Env } from '../src/config/env.js';
import { createPrismaClientForDatabase } from '../src/lib/prisma-client.js';
import { createS3Client } from '../src/lib/s3.js';
import { createObjectStorage } from '../src/lib/storage.js';
import {
	createCryptoIdGenerator,
	createNodeFileSystem,
	createSystemClock,
} from '../src/infrastructure/production-ports.js';
import { createRootLogger } from '../src/lib/logger.js';
import { createUploadLifecycleMetrics } from '../src/lib/upload-lifecycle-metrics.js';
import { createProductionUploadLifecycleRuntime } from '../src/modules/upload-lifecycle/runtime.js';
import { createNodeProjectUploadProcessing } from '../src/infrastructure/project-upload-processing.js';
import { createProjectUploadPipeline } from '../src/modules/admin/project/project-upload.adapter.js';
import {
	processImage,
	type ImageProcessingInput,
	type ImageProcessingResult,
} from '../src/modules/assets/upload/image-processing.js';
import {
	processPdf,
	type PdfProcessingInput,
} from '../src/modules/assets/upload/pdf-processing.js';
import {
	processVideo,
	type VideoProcessingInput,
	type VideoProcessingResult,
} from '../src/modules/assets/upload/video-processing.js';
import {
	createNodeVideoProcessingOperations,
} from '../src/modules/assets/upload/video-processing.adapter.js';

export interface ScriptUploadProcessing {
	image(input: ImageProcessingInput): Promise<ImageProcessingResult>;
	pdf(input: PdfProcessingInput): Promise<ImageProcessingResult>;
	video(input: VideoProcessingInput): Promise<VideoProcessingResult>;
}

export function bucketForKind(
	config: Pick<Env, 'S3_BUCKET_PUBLIC' | 'S3_BUCKET_PROTECTED'>,
	kind: AssetKind,
): string {
	return kind === 'GAME' || kind === 'VIDEO'
		? config.S3_BUCKET_PROTECTED
		: config.S3_BUCKET_PUBLIC;
}

/** CPU/filesystem adapters for one administrative upload invocation. */
export function createScriptUploadProcessing(config: Env): ScriptUploadProcessing {
	const fileSystem = createNodeFileSystem();
	const logger = createRootLogger(config);
	const videoOperations = createNodeVideoProcessingOperations(fileSystem);
	return {
		image: (input) => processImage(input, fileSystem),
		pdf: (input) => processPdf(input, logger, fileSystem),
		video: (input) => processVideo(input, logger, videoOperations),
	};
}

/** Resources owned by a one-shot administrative script invocation. */
export function createScriptResources(config: Env) {
	const prisma = createPrismaClientForDatabase(config.DATABASE_URL);
	const s3 = createS3Client(config);
	const fileSystem = createNodeFileSystem();
	const storage = createObjectStorage(s3, {
		defaultPresignTtlSec: config.S3_PRESIGN_TTL_SEC,
	});
	const logger = createRootLogger(config);
	const clock = createSystemClock();
	const ids = createCryptoIdGenerator();
	const uploadLifecycle = createProductionUploadLifecycleRuntime({
		config,
		prisma,
		storage,
		clock,
		ids,
		logger,
		metrics: createUploadLifecycleMetrics(),
	});
	const projectUploadProcessing = createNodeProjectUploadProcessing(fileSystem, logger);
	const createUploadPipeline = () => createProjectUploadPipeline({
		storage,
		fileSystem,
		ids,
		logger,
		processing: projectUploadProcessing,
		bucketForKind: (kind) => bucketForKind(config, kind),
		deleteUnpersistedObject: uploadLifecycle.orphanDeletions.deleteOrQueue,
		uploadIntents: uploadLifecycle.uploadIntents,
	});
	let closePromise: Promise<void> | undefined;

	return {
		prisma,
		storage,
		fileSystem,
		logger,
		clock,
		ids,
		uploadLifecycle,
		createUploadPipeline,
		close() {
			closePromise ??= (async () => {
				await uploadLifecycle.close();
				s3.destroy();
				await prisma.$disconnect();
			})();
			return closePromise;
		},
	};
}
