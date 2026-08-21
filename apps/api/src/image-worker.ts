import { pathToFileURL } from 'node:url';
import { loadEnv } from './config/env.js';
import { createCryptoIdGenerator, createSystemClock } from './infrastructure/production-ports.js';
import { createRootLogger } from './lib/logger.js';
import { createPrismaClientForDatabase } from './lib/prisma-client.js';
import { createS3Client } from './lib/s3.js';
import { createObjectStorage } from './lib/storage.js';
import { runImageWorkerLoop } from './modules/image/loop.js';
import { createImageWorkerComposition } from './modules/image/composition.js';
import { createPrismaImageWorkerRepository } from './modules/image/prisma.repository.js';

/** Dedicated Garage-to-private-workspace image/PDF worker; it never imports Fastify. */
export async function runImageWorker(): Promise<void> {
	const config = loadEnv();
	const logger = createRootLogger(config).child({ process: 'image-worker' });
	const prisma = createPrismaClientForDatabase(config.DATABASE_URL, {
		log: config.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
	});
	const s3 = createS3Client(config);
	const storage = createObjectStorage(s3, { defaultPresignTtlSec: config.S3_PRESIGN_TTL_SEC });
	const abort = new AbortController();
	const stop = () => abort.abort(new Error('IMAGE worker shutdown requested'));
	process.once('SIGTERM', stop);
	process.once('SIGINT', stop);
	try {
		const graph = createImageWorkerComposition({
			repository: createPrismaImageWorkerRepository(prisma, { publicBucket: config.S3_BUCKET_PUBLIC }),
			storage: {
				async stream(bucket, key, signal) {
					const object = await storage.stream(bucket, key, undefined, { signal });
					if (!object || 'kind' in object) throw new Error('Image source object is unavailable');
					return { body: object.body, size: object.size };
				},
				async head(bucket, key, signal) {
					const object = await storage.head(bucket, key, { signal });
					return object ? { size: object.size } : null;
				},
				async upload(input) {
					await storage.upload(input.bucket, input.key, input.body, input.contentType, input.contentLength, {
						cacheControl: 'public, max-age=31536000, immutable',
					}, { signal: input.signal });
				},
			},
			tempRoot: config.IMAGE_WORKER_TEMP_ROOT,
			protectedBucket: config.S3_BUCKET_PROTECTED,
			publicBucket: config.S3_BUCKET_PUBLIC,
			ids: createCryptoIdGenerator(),
			clock: createSystemClock(),
			logger,
			limits: { maxTempBytes: config.IMAGE_WORKER_TEMP_MAX_MB * 1024 * 1024 },
		});
		await runImageWorkerLoop({
			worker: graph.worker,
			signal: abort.signal,
			idleMs: config.IMAGE_WORKER_POLL_MS,
			onError: (error) => logger.error({ error }, 'IMAGE worker pass failed; retrying'),
		});
	} finally {
		process.off('SIGTERM', stop);
		process.off('SIGINT', stop);
		await prisma.$disconnect().catch(() => undefined);
		s3.destroy();
	}
}

const executedPath = process.argv[1];
if (executedPath && import.meta.url === pathToFileURL(executedPath).href) {
	void runImageWorker().catch((error) => {
		console.error('Fatal IMAGE worker error:', error);
		process.exitCode = 1;
	});
}
