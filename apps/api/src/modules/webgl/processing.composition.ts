import type { AppLogger, Clock, IdGenerator, ObjectStorage } from '../../application/ports.js';
import { createWebglProcessingProcessor, type WebglProcessingRepository } from './processing.js';
import {
	createWebglProcessingWorker,
	createWebglProcessingWorkerLoop,
	type WebglProcessingWorkerOptions,
	type WebglProcessingWorkerRepository,
} from './processing-worker.js';

export type WebglProcessingPersistence = WebglProcessingRepository
	& WebglProcessingWorkerRepository;

export interface WebglProcessingGraphOptions extends WebglProcessingWorkerOptions {
	tempRoot: string;
	tempDiskBudgetBytes: number;
	physicalArchiveByteLimit: number;
	pollIntervalMs: number;
}

export function createWebglTempDiskBudget(maxBytes: number) {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
		throw new RangeError('WebGL temp disk budget must be a positive safe integer');
	}
	let used = 0;
	return {
		tryReserve(bytes: number): (() => void) | null {
			if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > maxBytes - used) return null;
			used += bytes;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				used -= bytes;
			};
		},
		usage: () => used,
	};
}

/** Processing-only graph. Fastify and BackendContext must never import it. */
export function createWebglProcessingGraph(deps: {
	publicBucket: string;
	storage: Pick<ObjectStorage, 'stream' | 'upload' | 'head'>;
	repository: WebglProcessingPersistence;
	ids: IdGenerator;
	clock: Clock;
	logger: Pick<AppLogger, 'warn' | 'error'>;
	options: WebglProcessingGraphOptions;
}) {
	const diskBudget = createWebglTempDiskBudget(deps.options.tempDiskBudgetBytes);
	const processor = createWebglProcessingProcessor({
		publicBucket: deps.publicBucket,
		tempRoot: deps.options.tempRoot,
		physicalArchiveByteLimit: deps.options.physicalArchiveByteLimit,
		diskBudget,
		repository: deps.repository,
		storage: {
			async openSource(input) {
				const source = await deps.storage.stream(
					input.bucket,
					input.objectKey,
					undefined,
					{ signal: input.signal },
				);
				if (!source || 'kind' in source) {
					throw new Error('Canonical WEBGL_SOURCE object is unavailable');
				}
				return { body: source.body, sizeBytes: source.size };
			},
		},
		uploader: {
			put: async (object) => deps.storage.upload(
				object.bucket,
				object.objectKey,
				object.body,
				object.contentType,
				object.contentLength,
				{
					contentType: object.contentType,
					...(object.contentEncoding ? { contentEncoding: object.contentEncoding } : {}),
					cacheControl: object.cacheControl,
				},
				object.signal ? { signal: object.signal } : undefined,
			),
			async head(input) {
				const head = await deps.storage.head(input.bucket, input.objectKey, { signal: input.signal });
				if (!head) return null;
				return {
					sizeBytes: head.size,
					mimeType: head.contentType,
					etag: head.etag ?? null,
					checksumSha256: null,
				};
			},
		},
		ids: deps.ids,
		logger: deps.logger,
	});
	const worker = createWebglProcessingWorker({
		repository: deps.repository,
		processor,
		ids: deps.ids,
		clock: deps.clock,
		options: {
			concurrency: deps.options.concurrency,
			leaseMs: deps.options.leaseMs,
			heartbeatMs: deps.options.heartbeatMs,
		},
		logger: deps.logger,
	});
	const loop = createWebglProcessingWorkerLoop({
		runPass: worker.runPass,
		pollIntervalMs: deps.options.pollIntervalMs,
		logger: deps.logger,
	});
	return { diskBudget, processor, worker, loop };
}
