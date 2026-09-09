import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createPrismaClientForDatabase } from './lib/prisma-client.js';
import { createS3Client } from './lib/s3.js';
import { createObjectStorage } from './lib/storage.js';
import { createRootLogger } from './lib/logger.js';
import { createCryptoIdGenerator, createSystemClock } from './infrastructure/production-ports.js';
import { createWebglProcessingRepository } from './modules/asset-upload/webgl-processing-repository.js';
import { createWebglProcessingGraph } from './modules/webgl/processing.composition.js';

/** Dedicated WebGL validation/publication process; it never constructs an HTTP server. */
export async function runWebglWorker(): Promise<void> {
	const { loadEnv } = await import('./config/env.js');
	const config = loadEnv();
	const logger = createRootLogger(config);
	const prisma = createPrismaClientForDatabase(config.DATABASE_URL);
	const s3 = createS3Client(config);
	const storage = createObjectStorage(s3, { defaultPresignTtlSec: config.S3_PRESIGN_TTL_SEC });
	const abort = new AbortController();
	const stop = () => abort.abort(new Error('WebGL worker is stopping'));
	process.once('SIGTERM', stop);
	process.once('SIGINT', stop);
	try {
		const graph = createWebglProcessingGraph({
			publicBucket: config.S3_BUCKET_PUBLIC,
			storage,
			repository: createWebglProcessingRepository(prisma),
			ids: createCryptoIdGenerator(),
			clock: createSystemClock(),
			logger,
			options: {
				tempRoot: join(config.DIRECT_UPLOAD_WORKER_TEMP_ROOT, 'webgl'),
				tempDiskBudgetBytes: config.DIRECT_UPLOAD_WORKER_TEMP_MAX_MB * 1024 * 1024,
				physicalArchiveByteLimit: config.UPLOAD_PRIVILEGED_GAME_MAX_MB * 1024 * 1024,
				concurrency: 1,
				leaseMs: 120_000,
				heartbeatMs: 30_000,
				pollIntervalMs: config.DIRECT_UPLOAD_WORKER_POLL_MS,
			},
		});
		await graph.loop.start();
		await new Promise<void>((resolve) => abort.signal.addEventListener('abort', () => resolve(), { once: true }));
		await graph.loop.close();
	} finally {
		process.off('SIGTERM', stop);
		process.off('SIGINT', stop);
		s3.destroy();
		await prisma.$disconnect();
	}
}

const executedPath = process.argv[1];
if (executedPath && import.meta.url === pathToFileURL(executedPath).href) {
	void runWebglWorker().catch((error) => {
		console.error('WebGL worker failed:', error);
		process.exitCode = 1;
	});
}
