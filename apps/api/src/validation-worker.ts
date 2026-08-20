import { pathToFileURL } from 'node:url';
import { rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Env } from './config/env.js';
import { createCryptoIdGenerator, createNodeFileSystem, createSystemClock } from './infrastructure/production-ports.js';
import { createPrismaClientForDatabase } from './lib/prisma-client.js';
import { createRootLogger } from './lib/logger.js';
import { createS3Client } from './lib/s3.js';
import { createObjectStorage } from './lib/storage.js';
import { createUploadLifecycleMetrics } from './lib/upload-lifecycle-metrics.js';
import { createGameUploadValidationGraph } from './modules/admin/game-upload/validation-worker.composition.js';
import { createValidationWorkerLoop } from './modules/admin/game-upload/validation-worker-loop.js';
import { recordGameUploadEvent } from './modules/admin/game-upload/observability.js';
import { createProductionUploadLifecycleRuntime } from './modules/upload-lifecycle/runtime.js';

export type ValidationWorkerEnv = Env;

export async function createProductionValidationWorker(config: ValidationWorkerEnv) {
	const logger = createRootLogger(config).child({ processRole: 'validation-worker' });
	const clock = createSystemClock();
	const ids = createCryptoIdGenerator();
	const fileSystem = createNodeFileSystem();
	if (!fileSystem.ensurePrivateDirectory) {
		throw new Error('Validation worker requires private temp directory support');
	}
	await fileSystem.ensurePrivateDirectory(config.VALIDATION_WORKER_TEMP_ROOT);
	const workerDirectoryId = ids.next().replace(/[^a-zA-Z0-9-]/g, '');
	if (!workerDirectoryId) throw new Error('Validation worker temp ID is unsafe');
	const workerTempRoot = join(
		config.VALIDATION_WORKER_TEMP_ROOT,
		`worker-${process.pid}-${workerDirectoryId}`,
	);
	await fileSystem.ensurePrivateDirectory(workerTempRoot);
	const prisma = createPrismaClientForDatabase(config.DATABASE_URL);
	const s3 = createS3Client(config);
	const storage = createObjectStorage(s3, {
		defaultPresignTtlSec: config.S3_PRESIGN_TTL_SEC,
	});
	const uploadLifecycleMetrics = createUploadLifecycleMetrics();
	const uploadLifecycle = createProductionUploadLifecycleRuntime({
		config,
		prisma,
		storage,
		clock,
		ids,
		logger,
		metrics: uploadLifecycleMetrics,
	});
	const graph = createGameUploadValidationGraph({
		config,
		storage,
		fileSystem,
		ids,
		logger,
		uploadLifecycle,
		options: {
			concurrency: config.VALIDATION_WORKER_CONCURRENCY,
			claimLeaseMs: config.VALIDATION_WORKER_CLAIM_LEASE_MS,
			tempRoot: workerTempRoot,
			tempDiskBudgetBytes: config.VALIDATION_WORKER_TEMP_DISK_BUDGET_BYTES,
		},
	});
	const observedRunPass = async (signal: AbortSignal) => {
		const result = await graph.worker.runPass(signal);
		const [queue, cleanupBacklog] = await Promise.all([
			prisma.gameUploadSession.aggregate({
				where: { status: 'VERIFYING' },
				_count: { _all: true },
				_min: { updatedAt: true },
			}),
			Promise.all([
				prisma.orphanObject.count({ where: { state: { in: ['PENDING', 'DELETE_CLAIMED'] } } }),
				prisma.multipartAbortTask.count({ where: { state: { in: ['PENDING', 'CLAIMED'] } } }),
			]).then(([orphans, aborts]) => orphans + aborts),
		]);
		const queueDepth = queue._count._all;
		const queueLagMs = queue._min.updatedAt
			? Math.max(0, Date.now() - queue._min.updatedAt.getTime())
			: 0;
		recordGameUploadEvent({ logger }, 'worker_queue_lag', {
			queueDepth,
			queueLagMs,
			result: 'snapshot',
		});
		recordGameUploadEvent({ logger }, 'worker_active_count', {
			activeCount: graph.metrics.active(),
			result: 'snapshot',
		});
		recordGameUploadEvent({ logger }, 'worker_temp_disk_usage', {
			tempBytes: graph.metrics.tempBytes(),
			result: 'snapshot',
		});
		recordGameUploadEvent({ logger }, 'cleanup_task_backlog', {
			cleanupBacklog,
			result: 'snapshot',
		});
		recordGameUploadEvent({ logger }, 'untracked_multipart', {
			untrackedCount: uploadLifecycleMetrics.untrackedMultipartCleanupFailureCount(),
			result: 'failure_counter_snapshot',
		});
		return result;
	};
	const runtime = createValidationWorkerLoop({
		runPass: observedRunPass,
		pollIntervalMs: config.VALIDATION_WORKER_POLL_MS,
		logger,
	});
	let closePromise: Promise<void> | undefined;
	return {
		graph,
		async start() {
			await uploadLifecycle.start();
			await runtime.start();
		},
		close() {
			closePromise ??= (async () => {
				await runtime.close();
				await uploadLifecycle.close();
				storage.close?.();
				s3.destroy();
				await prisma.$disconnect();
				await rmdir(workerTempRoot).catch(() => undefined);
			})();
			return closePromise;
		},
	};
}

async function main(): Promise<void> {
	const { loadEnv } = await import('./config/env.js');
	const worker = await createProductionValidationWorker(loadEnv());
	let shuttingDown = false;
	const shutdown = async (reason: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		try {
			await worker.close();
		} catch (error) {
			console.error(`Validation worker shutdown failed after ${reason}:`, error);
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
		console.error('Fatal validation worker startup error:', error);
		process.exitCode = 1;
	});
}
