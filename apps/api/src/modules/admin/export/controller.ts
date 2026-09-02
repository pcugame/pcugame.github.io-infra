import type { FastifyPluginAsync } from 'fastify';
import { requireRole } from '../../../plugins/auth.js';
import { badRequest } from '../../../shared/errors.js';
import { sendOk } from '../../../shared/http.js';
import type { createExportService } from './service.js';

export function createExportController(deps: {
	service: ReturnType<typeof createExportService>;
}): FastifyPluginAsync {
	return async function exportController(app): Promise<void> {
		app.post<{ Body: { year?: number; dryRun?: boolean } }>(
			'/export',
			{ preHandler: requireRole('ADMIN') },
			async (request, reply) => {
				const body = request.body ?? {};
				const year = body.year === undefined ? undefined : Number(body.year);
				if (year !== undefined && (!Number.isInteger(year) || year < 2000)) {
					throw badRequest('Invalid year');
				}
				const job = await deps.service.createJob({
					requestedById: request.currentUser!.id,
					...(year === undefined ? {} : { year }),
					dryRun: body.dryRun ?? false,
				});
				sendOk(reply, { jobId: job.id, state: 'QUEUED' }, 202);
			},
		);

		app.get('/export/status', { preHandler: requireRole('ADMIN') }, async (_request, reply) => {
			const job = await deps.service.latestJob();
			sendOk(reply, job ? {
				running: job.state === 'QUEUED' || job.state === 'RUNNING',
				progress: job.progress,
				jobId: job.id,
				state: job.state,
				result: job.result,
				error: job.error,
			} : { running: false, progress: null });
		});
	};
}
