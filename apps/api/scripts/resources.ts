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

export function bucketForKind(
	config: Pick<Env, 'S3_BUCKET_PUBLIC' | 'S3_BUCKET_PROTECTED'>,
	kind: AssetKind,
): string {
	return kind === 'GAME' || kind === 'VIDEO'
		? config.S3_BUCKET_PROTECTED
		: config.S3_BUCKET_PUBLIC;
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
