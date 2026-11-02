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
	let paused = false;
	let startPromise: Promise<void> | undefined;
	let closePromise: Promise<void> | undefined;
	let deletionPending = false;
	let deletionFlight: Promise<void> | undefined;
	let maintenancePending = false;
	let maintenanceFlight: Promise<void> | undefined;

	function ensureDeletionWorker(signal?: AbortSignal): Promise<void> {
		deletionPending = true;
		if (deletionFlight) return deletionFlight;
		if (paused) return Promise.resolve();
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
			} while (deletionPending && !closing && !paused);
		})().finally(() => {
			deletionFlight = undefined;
			if (deletionPending && started && !closing && !paused) scheduleDeletionWorker();
		});
		return deletionFlight;
	}

	function scheduleDeletionWorker(): void {
		if (!started || paused || closing) return;
		queueMicrotask(() => {
			if (!started || paused || closing || !deletionPending) return;
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
		if (paused) return Promise.resolve();
		if (closing) return Promise.reject(new Error('Upload lifecycle runtime is closing'));
		const operationSignal = combinedSignal(closeController.signal, signal);
		maintenanceFlight = (async () => {
			do {
				maintenancePending = false;
				if (operationSignal.aborted) return;
				const results = await Promise.allSettled([
					services.multipartAborts.run(operationSignal),
					services.uploadIntents.sweep(operationSignal),
					services.idempotency.purgeExpired(services.clock.now()),
				]);
				const failed = results.find(result => result.status === 'rejected');
				if (failed?.status === 'rejected') throw failed.reason;
			} while (maintenancePending && !closing && !paused);
		})().finally(() => {
			maintenanceFlight = undefined;
			if (maintenancePending && started && !closing && !paused) scheduleMaintenance();
		});
		return maintenanceFlight;
	}

	function scheduleMaintenance(): void {
		if (!started || paused || closing) return;
		queueMicrotask(() => {
			if (!started || paused || closing || !maintenancePending) return;
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
		quiesce() { paused = true; },
		async resume() {
			paused = false;
			started = true;
			await runtime.recover();
		},
		activity: () => Number(!!deletionFlight) + Number(!!maintenanceFlight) + (services.background?.active() ?? 0),
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
				await services.background?.settled();
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
	// A renewal deadline may return before the database promise settles. Preserve
	// the existing cancellation deadline while retaining deployment visibility.
	const renewalFlights = new Set<Promise<unknown>>();
	const orphanRepository = createOrphanRepository(deps.prisma);
	const background = {
		active: () => renewalFlights.size,
		async settled() { await Promise.allSettled([...renewalFlights]); },
	};
	const orphans = createOrphanService({
		clock: deps.clock,
		storage: deps.storage,
		repository: {
			...orphanRepository,
			renewActiveClaim(...args) {
				const operation = orphanRepository.renewActiveClaim(...args);
				renewalFlights.add(operation);
				return operation.finally(() => { renewalFlights.delete(operation); });
			},
		},
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
	return createUploadLifecycleRuntime({
		idempotency,
		uploadIntents,
		orphanDeletions,
		multipartAborts,
		orphans,
		clock: deps.clock,
		logger: deps.logger,
		metrics: deps.metrics,
		background,
	});
}
