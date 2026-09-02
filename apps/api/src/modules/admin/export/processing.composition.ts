import type { ObjectStorage } from '../../../application/ports.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import { createExportRepository } from './repository.js';
import { createNasExportStaging } from './nas-staging.adapter.js';
import { createExportWorker } from './worker.js';
import { createExportWorkerLoop } from './worker-loop.js';

/** Composition root imported only by the dedicated export-worker process. */
export function createExportProcessingGraph(deps: {
	prisma: PrismaClient;
	storage: ObjectStorage;
	ids: { next(): string };
	logger: {
		info(context: Record<string, unknown>, message: string): void;
		warn(context: Record<string, unknown>, message: string): void;
		error(context: Record<string, unknown>, message: string): void;
	};
	config: {
		outDir: string;
		publicBucket: string;
		protectedBucket: string;
		concurrency: number;
		leaseMs: number;
		pollIntervalMs: number;
		maxObjectBytes: number;
		maxJobBytes: number;
		retryBaseMs: number;
	};
}) {
	const repository = createExportRepository(deps.prisma, {
		publicBucket: deps.config.publicBucket,
		protectedBucket: deps.config.protectedBucket,
	});
	const staging = createNasExportStaging({ outDir: deps.config.outDir, ids: deps.ids, logger: deps.logger });
	const worker = createExportWorker({
		repository,
		ids: deps.ids,
		staging,
		logger: deps.logger,
		options: {
			concurrency: deps.config.concurrency,
			leaseMs: deps.config.leaseMs,
			maxObjectBytes: deps.config.maxObjectBytes,
			maxJobBytes: deps.config.maxJobBytes,
			retryBaseMs: deps.config.retryBaseMs,
		},
		reader: {
			async open(input) {
				const object = await deps.storage.stream(
					input.bucket,
					input.objectKey,
					undefined,
					{ signal: input.signal },
				);
				if (!object) return null;
				if ('kind' in object) throw new Error(`Storage returned ${object.kind} for an unconditional worker read`);
				return { body: object.body, sizeBytes: object.size, etag: object.etag ?? null };
			},
		},
	});
	const loop = createExportWorkerLoop({
		runPass: worker.runPass,
		pollIntervalMs: deps.config.pollIntervalMs,
		logger: deps.logger,
	});
	return { repository, worker, loop };
}
