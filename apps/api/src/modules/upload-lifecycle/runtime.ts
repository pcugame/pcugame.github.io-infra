import type { AppLogger, Clock, IdGenerator, ObjectStorage } from '../../application/ports.js';
import { createObjectDeletionCoordinator } from '../../application/object-deletion.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { UploadLifecycleMetrics } from '../../lib/upload-lifecycle-metrics.js';
import { createIdempotencyRepository } from '../idempotency/repository.js';
import { createIdempotencyService } from '../idempotency/service.js';
import { createMultipartAbortRepository } from '../multipart-abort/repository.js';
import { createMultipartAbortService } from '../multipart-abort/service.js';
import { createObjectReferenceResolver } from '../orphan/reference-resolver.js';
import { createOrphanRepository } from '../orphan/repository.js';
import { createOrphanService } from '../orphan/service.js';
import { createUploadIntentRepository } from '../upload-intent/repository.js';
import { createUploadIntentService } from '../upload-intent/service.js';
import { createGameUploadRepository } from '../admin/game-upload/repository.js';
import type {
	UploadLifecycleRuntime,
	UploadLifecycleRuntimeServices,
} from './ports.js';

export type {
	IdempotencyService,
	MultipartAbortService,
	OrphanService,
	UploadIntentService,
	UploadLifecycleRuntime,
	UploadLifecycleRuntimeServices,
} from './ports.js';

const ORPHAN_BATCH_SIZE = 50;

function combinedSignal(
	owned: AbortSignal,
	external?: AbortSignal,
): AbortSignal {
	return external ? AbortSignal.any([owned, external]) : owned;
}

/**
 * Context-owned lifecycle and single-flight worker implementation. This
 * constructor is also the explicit test seam; production dependency discovery
 * never depends on the shape of a Prisma fake.
 */
export function createUploadLifecycleRuntime(
	services: UploadLifecycleRuntimeServices,
): UploadLifecycleRuntime {
	const closeController = new AbortController();
	let started = false;
	let closing = false;
	let startPromise: Promise<void> | undefined;
	let closePromise: Promise<void> | undefined;
	let deletionPending = false;
	let deletionFlight: Promise<void> | undefined;
	let maintenancePending = false;
	let maintenanceFlight: Promise<void> | undefined;

	function ensureDeletionWorker(signal?: AbortSignal): Promise<void> {
		deletionPending = true;
		if (deletionFlight) return deletionFlight;
		if (closing) return Promise.reject(new Error('Upload lifecycle runtime is closing'));
		const operationSignal = combinedSignal(closeController.signal, signal);
		deletionFlight = (async () => {
			do {
				deletionPending = false;
				if (operationSignal.aborted) return;
				const result = await services.orphans.runOrphanReaper(operationSignal);
				if (result.tried === ORPHAN_BATCH_SIZE && !operationSignal.aborted) {
					deletionPending = true;
				}
			} while (deletionPending && !closing);
		})().finally(() => {
			deletionFlight = undefined;
			if (deletionPending && started && !closing) scheduleDeletionWorker();
		});
		return deletionFlight;
	}

	function scheduleDeletionWorker(): void {
		if (!started || closing) return;
		queueMicrotask(() => {
			if (!started || closing || !deletionPending) return;
			void ensureDeletionWorker().catch((error) => {
				services.logger.error(
					{ error },
					'Context-owned orphan deletion worker failed',
				);
			});
		});
	}

	function ensureMaintenance(signal?: AbortSignal): Promise<void> {
		maintenancePending = true;
		if (maintenanceFlight) return maintenanceFlight;
		if (closing) return Promise.reject(new Error('Upload lifecycle runtime is closing'));
		const operationSignal = combinedSignal(closeController.signal, signal);
		maintenanceFlight = (async () => {
			do {
				maintenancePending = false;
				if (operationSignal.aborted) return;
				await Promise.all([
					services.multipartAborts.run(operationSignal),
					services.uploadIntents.sweep(operationSignal),
					services.idempotency.purgeExpired(services.clock.now()),
				]);
			} while (maintenancePending && !closing);
		})().finally(() => {
			maintenanceFlight = undefined;
			if (maintenancePending && started && !closing) scheduleMaintenance();
		});
		return maintenanceFlight;
	}

	function scheduleMaintenance(): void {
		if (!started || closing) return;
		queueMicrotask(() => {
			if (!started || closing || !maintenancePending) return;
			void ensureMaintenance().catch((error) => {
				services.logger.error(
					{ error },
					'Context-owned upload lifecycle maintenance failed',
				);
			});
		});
	}

	const runtime: UploadLifecycleRuntime = {
		idempotency: services.idempotency,
		uploadIntents: services.uploadIntents,
		orphanDeletions: services.orphanDeletions,
		multipartAborts: services.multipartAborts,
		gameUploads: services.gameUploads,
		metrics: services.metrics,
		wakeDeletionWorker() {
			if (closing) return;
			deletionPending = true;
			scheduleDeletionWorker();
		},
		wakeMaintenance() {
			if (closing) return;
			deletionPending = true;
			maintenancePending = true;
			scheduleDeletionWorker();
			scheduleMaintenance();
		},
		async recover(signal?: AbortSignal) {
			if (closing) throw new Error('Upload lifecycle runtime is closing');
			await Promise.all([
				ensureDeletionWorker(signal),
				ensureMaintenance(signal),
			]);
		},
		start() {
			startPromise ??= (async () => {
				if (closing) throw new Error('Upload lifecycle runtime is closed');
				started = true;
				await runtime.recover();
			})();
			return startPromise;
		},
		close() {
			closePromise ??= (async () => {
				closing = true;
				deletionPending = false;
				maintenancePending = false;
				closeController.abort(new Error('Upload lifecycle runtime is closing'));
				await Promise.allSettled([
					...(deletionFlight ? [deletionFlight] : []),
					...(maintenanceFlight ? [maintenanceFlight] : []),
				]);
			})();
			return closePromise;
		},
	};

	return runtime;
}

export function createProductionUploadLifecycleRuntime(deps: {
	config: { S3_BUCKET_PUBLIC: string; S3_BUCKET_PROTECTED: string };
	prisma: PrismaClient;
	storage: ObjectStorage;
	clock: Clock;
	ids: IdGenerator;
	logger: AppLogger;
	metrics: UploadLifecycleMetrics;
}): UploadLifecycleRuntime {
	const references = createObjectReferenceResolver(
		deps.prisma,
		{
			publicBucket: deps.config.S3_BUCKET_PUBLIC,
			protectedBucket: deps.config.S3_BUCKET_PROTECTED,
		},
		deps.logger,
	);
	const orphans = createOrphanService({
		clock: deps.clock,
		storage: deps.storage,
		repository: createOrphanRepository(deps.prisma),
		references,
		ids: deps.ids,
		logger: deps.logger,
	});
	const orphanDeletions = createObjectDeletionCoordinator({
		storage: deps.storage,
		orphans: { record: orphans.recordOrphan },
		logger: deps.logger,
	});
	const uploadIntents = createUploadIntentService({
		repository: createUploadIntentRepository(deps.prisma),
		references,
		storage: deps.storage,
		clock: deps.clock,
		ids: deps.ids,
		logger: deps.logger,
	});
	const idempotency = createIdempotencyService({
		repository: createIdempotencyRepository(deps.prisma),
		clock: deps.clock,
		ids: deps.ids,
	});
	const multipartAborts = createMultipartAbortService({
		repository: createMultipartAbortRepository(deps.prisma),
		storage: deps.storage,
		clock: deps.clock,
		ids: deps.ids,
		logger: deps.logger,
	});
	const gameUploads = createGameUploadRepository(deps.prisma, {
		abortBucket: deps.config.S3_BUCKET_PROTECTED,
		publicBucket: deps.config.S3_BUCKET_PUBLIC,
	});

	return createUploadLifecycleRuntime({
		idempotency,
		uploadIntents,
		orphanDeletions,
		multipartAborts,
		gameUploads,
		orphans,
		clock: deps.clock,
		logger: deps.logger,
		metrics: deps.metrics,
	});
}
