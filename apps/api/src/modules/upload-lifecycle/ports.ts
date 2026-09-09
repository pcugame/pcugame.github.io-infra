import type { AppLogger, Clock } from '../../application/ports.js';
import type { ObjectDeletionCoordinator } from '../../application/object-deletion.js';
import type { UploadLifecycleMetrics } from '../../lib/upload-lifecycle-metrics.js';
import type { createIdempotencyService } from '../idempotency/service.js';
import type { createMultipartAbortService } from '../multipart-abort/service.js';
import type { createOrphanService } from '../orphan/service.js';
import type { createUploadIntentService } from '../upload-intent/service.js';
import type { DurableGameUploadRepository } from '../admin/game-upload/repository.js';

export type IdempotencyService = ReturnType<typeof createIdempotencyService>;
export type UploadIntentService = ReturnType<typeof createUploadIntentService>;
export type MultipartAbortService = ReturnType<typeof createMultipartAbortService>;
export type OrphanService = ReturnType<typeof createOrphanService>;

/** Required durable ports shared by every feature graph in one BackendContext. */
export interface UploadLifecycleRuntime {
	idempotency: IdempotencyService;
	uploadIntents: UploadIntentService;
	orphanDeletions: ObjectDeletionCoordinator;
	multipartAborts: MultipartAbortService;
	gameUploads: DurableGameUploadRepository;
	metrics: UploadLifecycleMetrics;
	wakeDeletionWorker(): void;
	wakeMaintenance(): void;
	recover(signal?: AbortSignal): Promise<void>;
	start(): Promise<void>;
	close(): Promise<void>;
}

export interface UploadLifecycleRuntimeServices {
	idempotency: IdempotencyService;
	uploadIntents: UploadIntentService;
	orphanDeletions: ObjectDeletionCoordinator;
	multipartAborts: MultipartAbortService;
	gameUploads: DurableGameUploadRepository;
	orphans: OrphanService;
	clock: Clock;
	logger: AppLogger;
	metrics: UploadLifecycleMetrics;
}
