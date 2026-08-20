import { pathToFileURL } from 'node:url';
import type { AssetKind } from './generated/prisma/client.js';
import type { Env } from './config/env.js';
import {
	createCryptoIdGenerator,
	createNodeFileSystem,
} from './infrastructure/production-ports.js';
import { createPrismaClientForDatabase } from './lib/prisma-client.js';
import { createRootLogger } from './lib/logger.js';
import { createS3Client } from './lib/s3.js';
import { createObjectStorage } from './lib/storage.js';
import { createExportFileWriter } from './modules/admin/export/file.adapter.js';
import { createExportRepository } from './modules/admin/export/repository.js';
import { createExportWorker } from './modules/admin/export/worker.js';
import { createExportWorkerLoop } from './modules/admin/export/worker-loop.js';

function bucketForKind(kind: AssetKind, config: Env): string {
	return kind === 'GAME' || kind === 'VIDEO'
		? config.S3_BUCKET_PROTECTED
		: config.S3_BUCKET_PUBLIC;
}

/** Processing-only graph: this is the sole owner of export object reads/NAS writes. */
export async function createProductionExportWorker(config: Env) {
	const logger = createRootLogger(config).child({ processRole: 'export-worker' });
	const ids = createCryptoIdGenerator();
	const fileSystem = createNodeFileSystem();
	const prisma = createPrismaClientForDatabase(config.DATABASE_URL);
	const s3 = createS3Client(config);
	const storage = createObjectStorage(s3, { defaultPresignTtlSec: config.S3_PRESIGN_TTL_SEC });
	const repository = createExportRepository(prisma);
	if (!config.NAS_EXPORT_PATH) throw new Error('NAS_EXPORT_PATH is required by export-worker');
	const fileWriter = createExportFileWriter({
		ids,
		async getObject(bucket, key, signal) {
			const object = await storage.stream(bucket, key, undefined, { signal });
			if (!object || 'kind' in object) throw new Error('Export source object not found');
			return object.body;
		},
		createWriteStream: (path) => fileSystem.createWriteStream(path),
		rename: (from, to) => fileSystem.rename(from, to),
		remove: (path) => fileSystem.remove(path),
		logCleanupError: (error, path) => logger.warn(
			{ error, path }, 'Failed to remove partial export file',
		),
	});
	const worker = createExportWorker({
		repository,
		ids,
		concurrency: config.EXPORT_WORKER_CONCURRENCY,
		claimLeaseMs: config.EXPORT_WORKER_CLAIM_LEASE_MS,
		outDir: config.NAS_EXPORT_PATH,
		async pathExists(path) {
			try { await fileSystem.access(path); return true; } catch { return false; }
		},
		ensureDirectory: (path) => fileSystem.mkdir(path, { recursive: true }),
		saveObject: fileWriter.saveObject,
		bucketForKind: (kind) => bucketForKind(kind, config),
		protectedBucket: config.S3_BUCKET_PROTECTED,
		logger: {
			info: (context, message) => logger.info(context, message),
			warn: (message) => logger.warn(message),
			error: (context, message) => logger.error(context, message),
		},
	});
	const loop = createExportWorkerLoop({
		runPass: worker.runPass,
		pollIntervalMs: config.EXPORT_WORKER_POLL_MS,
		logger,
	});
	let closePromise: Promise<void> | undefined;
	return {
		start: () => loop.start(),
		close() {
			closePromise ??= (async () => {
				await loop.close();
				storage.close?.();
				s3.destroy();
				await prisma.$disconnect();
			})();
			return closePromise;
		},
	};
}

async function main(): Promise<void> {
	const { loadEnv } = await import('./config/env.js');
	const worker = await createProductionExportWorker(loadEnv());
	let closing = false;
	const shutdown = async (reason: string) => {
		if (closing) return;
		closing = true;
		try { await worker.close(); } catch (error) {
			console.error(`Export worker shutdown failed after ${reason}:`, error);
			process.exitCode = 1;
		}
	};
	process.once('SIGTERM', () => void shutdown('SIGTERM'));
	process.once('SIGINT', () => void shutdown('SIGINT'));
	await worker.start();
}

const executedPath = process.argv[1];
if (executedPath && import.meta.url === pathToFileURL(executedPath).href) {
	void main().catch((error) => {
		console.error('Fatal export worker startup error:', error);
		process.exitCode = 1;
	});
}
