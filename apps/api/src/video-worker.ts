import { pathToFileURL } from 'node:url';
import { loadEnv } from './config/env.js';
import { createCryptoIdGenerator } from './infrastructure/production-ports.js';
import { createRootLogger } from './lib/logger.js';
import { createPrismaClientForDatabase } from './lib/prisma-client.js';
import { createS3Client } from './lib/s3.js';
import { createObjectStorage } from './lib/storage.js';
import { createVideoWorkerGraph } from './modules/video/composition.js';
import { runVideoWorkerLoop } from './modules/video/loop.js';

export async function runVideoWorker(): Promise<void> {
	const config = loadEnv();
	const logger = createRootLogger(config).child({ process: 'video-worker' });
	const prisma = createPrismaClientForDatabase(config.DATABASE_URL, {
		log: config.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
	});
	const s3 = createS3Client(config);
	const storage = createObjectStorage(s3, { defaultPresignTtlSec: config.S3_PRESIGN_TTL_SEC });
	const abort = new AbortController();
	const stop = () => abort.abort(new Error('VIDEO worker shutdown requested'));
	process.once('SIGTERM', stop);
	process.once('SIGINT', stop);
	try {
		const graph = createVideoWorkerGraph({
			prisma,
			storage,
			logger,
			ids: createCryptoIdGenerator(),
			protectedBucket: config.S3_BUCKET_PROTECTED,
			tempRoot: config.VIDEO_WORKER_TEMP_ROOT,
			tempDiskBudgetBytes: config.VIDEO_WORKER_TEMP_DISK_MB * 1024 * 1024,
		});
		const removed = await graph.cleanupStaleWorkspaces(
			new Date(Date.now() - 24 * 60 * 60_000),
		);
		if (removed > 0) logger.warn({ removed }, 'Removed stale VIDEO worker temp directories');
		await runVideoWorkerLoop({
			worker: graph.worker,
			signal: abort.signal,
			idleDelayMs: config.VIDEO_WORKER_POLL_MS,
			onError: (error) => logger.error({ error }, 'VIDEO worker pass failed; retrying'),
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
	void runVideoWorker().catch((error) => {
		console.error('Fatal VIDEO worker error:', error);
		process.exitCode = 1;
	});
}
