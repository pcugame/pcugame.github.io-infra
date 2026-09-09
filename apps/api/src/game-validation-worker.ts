import { pathToFileURL } from 'node:url';
import { createPrismaClientForDatabase } from './lib/prisma-client.js';
import { createS3Client } from './lib/s3.js';
import { createObjectStorage } from './lib/storage.js';
import { createRootLogger } from './lib/logger.js';
import { createCryptoIdGenerator } from './infrastructure/production-ports.js';
import { createAssetUploadRepository } from './modules/asset-upload/repository.js';
import { createAssetUploadValidationGraph } from './modules/asset-upload/validation-worker.composition.js';
import { assertDirectArchiveWorkerCapacity } from './shared/worker-capacity.js';

/** Dedicated GAME validation process; intentionally has no Fastify import. */
export async function runGameValidationWorker(): Promise<void> {
	const { loadEnv } = await import('./config/env.js');
	const config = loadEnv();
	const capacity = assertDirectArchiveWorkerCapacity(config, 'GAME');
	const logger = createRootLogger(config);
	const prisma = createPrismaClientForDatabase(config.DATABASE_URL);
	const s3 = createS3Client(config);
	const storage = createObjectStorage(s3, { defaultPresignTtlSec: config.S3_PRESIGN_TTL_SEC });
	const abort = new AbortController();
	const stop = () => abort.abort(new Error('GAME validation worker is stopping'));
	process.once('SIGTERM', stop);
	process.once('SIGINT', stop);
	try {
		const graph = createAssetUploadValidationGraph({
			repository: createAssetUploadRepository(prisma), storage,
			ids: createCryptoIdGenerator(), tempRoot: config.DIRECT_UPLOAD_WORKER_TEMP_ROOT,
			tempDiskBudgetBytes: capacity.tempBudgetBytes,
			logger, wakeDeletionWorker: () => undefined,
		});
		const sweep = async () => {
			const removed = await graph.cleanupStaleWorkspaces(new Date(Date.now() - 24 * 60 * 60_000));
			if (removed > 0) logger.warn({ removed }, 'Removed stale GAME worker temp directories');
		};
		await sweep();
		const scavenger = setInterval(() => void sweep().catch((error) => {
			logger.error({ error }, 'GAME worker temp scavenger failed');
		}), 60 * 60_000);
		scavenger.unref();
		try {
			await graph.loop.run(abort.signal);
		} finally {
			clearInterval(scavenger);
		}
	} finally {
		process.off('SIGTERM', stop);
		process.off('SIGINT', stop);
		s3.destroy();
		await prisma.$disconnect();
	}
}

const executedPath = process.argv[1];
if (executedPath && import.meta.url === pathToFileURL(executedPath).href) {
	void runGameValidationWorker().catch((error) => {
		console.error('GAME validation worker failed:', error);
		process.exitCode = 1;
	});
}
