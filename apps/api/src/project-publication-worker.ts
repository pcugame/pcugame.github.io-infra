import { waitForWorkerPoll } from './shared/worker-wait.js';
import { pathToFileURL } from 'node:url';
import { loadEnv } from './config/env.js';
import { createCryptoIdGenerator } from './infrastructure/production-ports.js';
import { createRootLogger } from './lib/logger.js';
import { createPrismaClientForDatabase } from './lib/prisma-client.js';
import { createS3Client } from './lib/s3.js';
import { createObjectStorage } from './lib/storage.js';
import { createProjectPublicationGraph } from './modules/project-publication/composition.js';
import { createProjectPublicationRepository } from './modules/project-publication/repository.js';

/** Dedicated Garage staging-to-public worker. Fastify never imports this graph. */
export async function runProjectPublicationWorker(): Promise<void> {
	const config = loadEnv();
	const logger = createRootLogger(config).child({ process: 'project-publication-worker' });
	const prisma = createPrismaClientForDatabase(config.DATABASE_URL);
	const s3 = createS3Client(config);
	const storage = createObjectStorage(s3, { defaultPresignTtlSec: config.S3_PRESIGN_TTL_SEC });
	const worker = createProjectPublicationGraph({
		repository: createProjectPublicationRepository(prisma),
		storage,
		ids: createCryptoIdGenerator(),
		logger,
	});
	const abort = new AbortController();
	const stop = () => abort.abort(new Error('Project publication worker is stopping'));
	process.once('SIGTERM', stop);
	process.once('SIGINT', stop);
	try {
		while (!abort.signal.aborted) {
			const result = await worker.runPass(abort.signal).catch((error) => {
				logger.error({ error }, 'Project publication pass failed');
				return { claimed: 0 };
			});
			if (result.claimed === 0) await waitForWorkerPoll(config.DIRECT_UPLOAD_WORKER_POLL_MS, abort.signal);
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
	void runProjectPublicationWorker().catch((error) => {
		console.error('Project publication worker failed:', error);
		process.exitCode = 1;
	});
}
