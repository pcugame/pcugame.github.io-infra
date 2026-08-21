import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv } from './config/env.js';
import { createCryptoIdGenerator } from './infrastructure/production-ports.js';
import { createRootLogger } from './lib/logger.js';
import { createPrismaClientForDatabase } from './lib/prisma-client.js';
import { createS3Client } from './lib/s3.js';
import { createObjectStorage } from './lib/storage.js';
import { createExportProcessingGraph } from './modules/admin/export/processing.composition.js';

function containsPath(parent: string, child: string): boolean {
	const relation = relative(parent, child);
	return relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation));
}

/**
 * Keep the NAS destination explicitly private and bounded before the worker
 * opens a database or storage connection. Symlink safety is checked again by
 * the worker-only staging adapter at materialization time.
 */
export function exportWorkerConfig(config: ReturnType<typeof loadEnv>) {
	const rawRoot = config.NAS_EXPORT_ROOT;
	if (!rawRoot) throw new Error('NAS_EXPORT_ROOT is required by the export worker');
	if (rawRoot.includes('\0') || !isAbsolute(rawRoot)) {
		throw new Error('NAS_EXPORT_ROOT must be an absolute private path');
	}
	const outDir = resolve(rawRoot);
	const publicRoot = config.UPLOAD_ROOT_PUBLIC ? resolve(config.UPLOAD_ROOT_PUBLIC) : undefined;
	if (outDir === resolve(sep) || (publicRoot && (
		containsPath(publicRoot, outDir) || containsPath(outDir, publicRoot)
	))) {
		throw new Error('NAS_EXPORT_ROOT must not be the legacy public storage path');
	}
	return {
		outDir,
		publicBucket: config.S3_BUCKET_PUBLIC,
		protectedBucket: config.S3_BUCKET_PROTECTED,
		concurrency: config.EXPORT_WORKER_FILE_CONCURRENCY,
		leaseMs: config.EXPORT_WORKER_LEASE_MS,
		pollIntervalMs: config.EXPORT_WORKER_POLL_MS,
		maxObjectBytes: config.EXPORT_WORKER_MAX_OBJECT_BYTES,
		maxJobBytes: config.EXPORT_WORKER_MAX_JOB_BYTES,
		retryBaseMs: config.EXPORT_WORKER_RETRY_BASE_MS,
	};
}

/** Dedicated Garage-to-NAS export process. It does not construct or import Fastify. */
export async function runExportWorker(): Promise<void> {
	const config = loadEnv();
	const workerConfig = exportWorkerConfig(config);
	const logger = createRootLogger(config).child({ process: 'export-worker' });
	const prisma = createPrismaClientForDatabase(config.DATABASE_URL, {
		log: config.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
	});
	const s3 = createS3Client(config);
	const storage = createObjectStorage(s3, { defaultPresignTtlSec: config.S3_PRESIGN_TTL_SEC });
	const graph = createExportProcessingGraph({
		prisma,
		storage,
		ids: createCryptoIdGenerator(),
		logger,
		config: workerConfig,
	});
	const abort = new AbortController();
	const stop = () => abort.abort(new Error('Export worker shutdown requested'));
	process.once('SIGTERM', stop);
	process.once('SIGINT', stop);
	try {
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
	void runExportWorker().catch((error) => {
		console.error('Export worker failed:', error);
		process.exitCode = 1;
	});
}
