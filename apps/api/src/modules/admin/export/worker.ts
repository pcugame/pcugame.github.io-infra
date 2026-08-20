import type { AssetKind } from '../../../generated/prisma/client.js';
import type { ClaimedExportJob, createExportRepository } from './repository.js';
import { createExportProgressStore, createExportService } from './service.js';

export interface ExportWorkerDependencies {
	repository: Pick<ReturnType<typeof createExportRepository>,
		'claimNext' | 'heartbeat' | 'complete' | 'fail' | 'findProjectsWithAssets'>;
	ids: { next(): string };
	concurrency: number;
	claimLeaseMs: number;
	outDir: string;
	pathExists(path: string): Promise<boolean>;
	ensureDirectory(path: string): Promise<void>;
	saveObject(bucket: string, key: string, destination: string, signal?: AbortSignal): Promise<void>;
	bucketForKind(kind: AssetKind): string;
	protectedBucket: string;
	logger: {
		info?(context: Record<string, unknown>, message: string): void;
		warn(message: string): void;
		error(context: Record<string, unknown>, message: string): void;
	};
}

export function createExportWorker(deps: ExportWorkerDependencies) {
	if (!Number.isInteger(deps.concurrency) || deps.concurrency < 1 || deps.concurrency > 4) {
		throw new RangeError('Export worker concurrency must be between 1 and 4');
	}
	if (!Number.isInteger(deps.claimLeaseMs) || deps.claimLeaseMs < 60_000) {
		throw new RangeError('Export worker claim lease must be at least 60 seconds');
	}

	async function process(job: ClaimedExportJob, outerSignal?: AbortSignal): Promise<void> {
		const progress = createExportProgressStore();
		const controller = new AbortController();
		const abort = () => controller.abort(outerSignal?.reason);
		if (outerSignal?.aborted) abort();
		else outerSignal?.addEventListener('abort', abort, { once: true });
		let pulseWork = Promise.resolve();
		const heartbeatMs = Math.max(1_000, Math.floor(deps.claimLeaseMs / 3));
		const pulse = () => {
			pulseWork = pulseWork.then(async () => {
				const owned = await deps.repository.heartbeat(
					job.id, job.claimToken, deps.claimLeaseMs, progress.get(),
				);
				if (!owned) controller.abort(new Error('Export job claim lost'));
			}).catch((error) => {
				deps.logger.error({ error, jobId: job.id }, 'Export job heartbeat failed');
				controller.abort(error);
			});
		};
		const heartbeat = setInterval(pulse, heartbeatMs);
		const service = createExportService({
			findProjects: (year) => deps.repository.findProjectsWithAssets(year),
			pathExists: deps.pathExists,
			ensureDirectory: deps.ensureDirectory,
			saveObject: deps.saveObject,
			bucketForKind: deps.bucketForKind,
			protectedBucket: deps.protectedBucket,
			now: Date.now,
			logWarn: deps.logger.warn,
			logError: deps.logger.error,
		}, progress);
		try {
			deps.logger.info?.({ action: 'export_started', jobId: job.id }, 'export_started');
			const result = await service.exportAssets({
				outDir: deps.outDir,
				...(job.year === null ? {} : { year: job.year }),
				dryRun: job.dryRun,
				signal: controller.signal,
			});
			pulse();
			await pulseWork;
			if (controller.signal.aborted || outerSignal?.aborted) return;
			if (!await deps.repository.complete(job.id, job.claimToken, result)) {
				throw new Error('Export completion claim was lost');
			}
			deps.logger.info?.({ action: 'export_completed', jobId: job.id }, 'export_completed');
		} catch (error) {
			if (!controller.signal.aborted && !outerSignal?.aborted) {
				await deps.repository.fail(job.id, job.claimToken, 'Export processing failed');
			}
			deps.logger.error({ error, jobId: job.id }, 'Export processing failed');
		} finally {
			clearInterval(heartbeat);
			outerSignal?.removeEventListener('abort', abort);
			await service.close();
			progress.close();
		}
	}

	return {
		async runPass(signal?: AbortSignal): Promise<number> {
			const jobs: ClaimedExportJob[] = [];
			while (jobs.length < deps.concurrency && !signal?.aborted) {
				const claimed = await deps.repository.claimNext(deps.ids.next(), deps.claimLeaseMs);
				if (!claimed) break;
				jobs.push(claimed);
			}
			await Promise.all(jobs.map((job) => process(job, signal)));
			return jobs.length;
		},
	};
}
