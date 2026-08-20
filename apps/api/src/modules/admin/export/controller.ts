import type { FastifyPluginAsync } from 'fastify';
import type { ExportStartResponse, ExportStatusResponse } from '@pcu/contracts';
import { sendOk } from '../../../shared/http.js';
import { requireRole } from '../../../plugins/auth.js';
import { badRequest } from '../../../shared/errors.js';

export interface ExportControllerDependencies {
	repository: {
		createJob(input: {
			id: string;
			requestedById: number;
			year: number | null;
			dryRun: boolean;
		}): Promise<{ id: string }>;
		latestJob(): Promise<{
			id: string;
			status: string;
			progress: ExportStatusResponse['progress'];
			result: ExportStatusResponse['result'];
			error: string | null;
		} | null>;
	};
	ids: { next(): string };
}

export function createExportController(
	deps: ExportControllerDependencies,
): FastifyPluginAsync {
	return async function exportController(app): Promise<void> {
	/**
	 * POST /export — enqueue a durable export job for the processing worker.
	 *
	 * Body (optional):
	 *   { year?: number, dryRun?: boolean }
	 *
	 * Returns 409 if another queued/running export exists. Once committed, the
	 * job is independent of the request and API process lifecycle.
	 */
	app.post<{ Body: { year?: number; dryRun?: boolean } }>(
		'/export',
		{ preHandler: requireRole('ADMIN') },
		async (request, reply) => {
			const body = (request.body ?? {});
			const year = body.year ? Number(body.year) : undefined;
			if (year != null && (!Number.isInteger(year) || year < 2000)) {
				throw badRequest('Invalid year');
			}

			const job = await deps.repository.createJob({
				id: deps.ids.next(),
				requestedById: request.currentUser!.id,
				year: year ?? null,
				dryRun: body.dryRun ?? false,
			});
			sendOk<ExportStartResponse>(reply, { jobId: job.id, status: 'QUEUED' }, 202);
		},
	);

	/**
	 * GET /export/status — read live progress of an in-flight export.
	 *
	 * Returns `{ running: false, progress: null }` when idle.
	 * The web admin polls this while the export modal is open.
	 */
	app.get(
		'/export/status',
		{ preHandler: requireRole('ADMIN') },
		async (_request, reply) => {
			const job = await deps.repository.latestJob();
			sendOk<ExportStatusResponse>(reply, job ? {
				running: job.status === 'QUEUED' || job.status === 'RUNNING',
				progress: job.progress,
				jobId: job.id,
				result: job.result,
				error: job.error,
			} : { running: false, progress: null });
		},
	);
	};
}
