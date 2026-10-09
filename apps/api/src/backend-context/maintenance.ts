import type { S3Client } from '@aws-sdk/client-s3';
import type {
	AppLogger,
	BackgroundMaintenance,
	Clock,
	IdGenerator,
	Scheduler,
} from '../application/ports.js';
import type { Env } from '../config/env.js';
import { createMultipartRecoveryStorage } from '../lib/storage.js';
import { createAssetUploadRecoveryService } from '../modules/asset-upload/recovery.service.js';
import type { createAssetUploadRepository } from '../modules/asset-upload/repository.js';
import type { UploadLifecycleRuntime } from '../modules/upload-lifecycle/runtime.js';
import type { BackendPersistencePorts } from './persistence.js';

export function createMaintenanceSchedule(
	scheduler: Scheduler,
	clock: Clock,
	maintenance: BackgroundMaintenance,
	logger: AppLogger,
): { start(): void; close(): Promise<void> } {
	const tasks: Array<{ cancel(): void }> = [];
	const inFlight = new Set<Promise<void>>();
	let started = false;
	let closed = false;
	let closePromise: Promise<void> | undefined;
	const abortController = new AbortController();

	async function runTracked(work: () => Promise<void>): Promise<void> {
		const operation = work();
		inFlight.add(operation);
		try {
			await operation;
		} finally {
			inFlight.delete(operation);
		}
	}

	return {
		start() {
			if (started) return;
			if (closed) throw new Error('Maintenance schedule is closed');
			started = true;
			tasks.push(scheduler.every(60 * 60 * 1000, () => runTracked(async () => {
				try {
					const count = await maintenance.purgeExpiredSessions(
						clock.now(),
						abortController.signal,
					);
					if (count > 0) logger.info({ count }, 'Purged expired sessions');
				} catch (error) {
					logger.error(error, 'Failed to purge expired sessions');
				}
			})));
			tasks.push(scheduler.every(60 * 1000, () => runTracked(async () => {
				try {
					await maintenance.reapOrphans(abortController.signal);
				} catch (error) {
					logger.error(error, 'Orphan reaper iteration crashed');
				}
			})));
			tasks.push(scheduler.every(60 * 1000, () => runTracked(async () => {
				try {
					await maintenance.recoverStaleUploads(abortController.signal);
				} catch (error) {
					logger.error(error, 'Upload lifecycle maintenance iteration crashed');
				}
			})));
			// Do not wait a full interval after a process restart: a crashed
			// completion lease and an unrecorded Garage multipart must be reclaimed
			// before they hold an active upload slot indefinitely.
			void runTracked(async () => {
				try {
					await maintenance.recoverStaleUploads(abortController.signal);
				} catch (error) {
					logger.error(error, 'Startup direct upload recovery crashed');
				}
			});
		},
		close() {
			closePromise ??= (async () => {
				closed = true;
				abortController.abort(new Error('Maintenance schedule is closing'));
				for (const task of [...tasks].reverse()) task.cancel();
				tasks.length = 0;
				await Promise.allSettled([...inFlight]);
			})();
			return closePromise;
		},
	};
}

/** Coalesce the complete game-recovery + temp-sweep sequence, not just either half. */
export function createSingleFlightUploadRecovery(
	recoverGame: (signal?: AbortSignal) => Promise<void>,
	sweepTemps: (signal?: AbortSignal) => Promise<unknown>,
): (signal?: AbortSignal) => Promise<void> {
	let inFlight: Promise<void> | undefined;
	return (signal?: AbortSignal) => {
		// Maintenance callers normally share one context signal. Reject a
		// pre-aborted invocation before it can become the shared operation.
		if (signal?.aborted) return Promise.resolve();
		if (inFlight) return inFlight;
		const operation = (async () => {
			try {
				await recoverGame(signal);
				if (!signal?.aborted) await sweepTemps(signal);
			} finally {
				inFlight = undefined;
			}
		})();
		inFlight = operation;
		return operation;
	};
}

export function createBackendMaintenance({
	config, directAssetUploadRepository, s3, clock, ids, logger, uploadLifecycle, persistence,
}: {
	config: Env;
	directAssetUploadRepository: ReturnType<typeof createAssetUploadRepository> | undefined;
	s3: S3Client;
	clock: Clock;
	ids: IdGenerator;
	logger: AppLogger;
	uploadLifecycle: UploadLifecycleRuntime;
	persistence: Pick<BackendPersistencePorts, 'authRepository' | 'purgeVoteInvestigations'>;
}): BackgroundMaintenance {
	const directAssetUploadRecovery = directAssetUploadRepository
		? createAssetUploadRecoveryService({
			repository: directAssetUploadRepository,
			storage: createMultipartRecoveryStorage(s3),
			clock,
			ids,
			logger,
			wakeMaintenance: () => uploadLifecycle.wakeMaintenance(),
			bucket: config.S3_BUCKET_PROTECTED,
		})
		: undefined;
	return {
		recoverStaleUploads: async (signal) => {
			if (signal?.aborted) return;
			await persistence.purgeVoteInvestigations?.();
			if (!directAssetUploadRecovery) return;
			await directAssetUploadRecovery.recover(signal);
		},
		async purgeExpiredSessions(before, signal) {
			if (signal?.aborted) return 0;
			return persistence.authRepository.purgeExpired(before);
		},
		reapOrphans: (signal) => uploadLifecycle.recover(signal),
	};
}
