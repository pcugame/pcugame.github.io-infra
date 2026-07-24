import type { FastifyPluginAsync } from 'fastify';
import type { ExportResult, ExportStatusResponse } from '@pcu/contracts';
import { sendOk } from '../../../shared/http.js';
import { requireRole } from '../../../plugins/auth.js';
import { badRequest } from '../../../shared/errors.js';
import type { createExportService } from './service.js';

export interface ExportControllerDependencies {
	service: ReturnType<typeof createExportService>;
	outDir?: string;
}

export function createExportController(
	deps: ExportControllerDependencies,
): FastifyPluginAsync {
	return async function exportController(app): Promise<void> {
	/**
	 * POST /export — export assets from S3 to NAS filesystem.
	 *
	 * Body (optional):
	 *   { year?: number, dryRun?: boolean }
	 *
	 * Writes to NAS_EXPORT_PATH env var directory.
	 * Idempotent: existing files are skipped on re-run.
	 *
	 * Returns 409 if another export is already in progress.
	 * Detects client disconnect and aborts early.
	 */
	app.post<{ Body: { year?: number; dryRun?: boolean } }>(
		'/export',
		{ preHandler: requireRole('ADMIN') },
		async (request, reply) => {
			const nasPath = deps.outDir;
			if (!nasPath) throw badRequest('NAS_EXPORT_PATH is not configured');

			const body = (request.body ?? {});
			const year = body.year ? Number(body.year) : undefined;
			if (year != null && (!Number.isInteger(year) || year < 2000)) {
				throw badRequest('Invalid year');
			}

			// Build an AbortController tied to the client connection
			const ac = new AbortController();
			const onClose = () => {
				if (!reply.sent) ac.abort();
			};
			request.raw.once('aborted', onClose);
			reply.raw.once('close', onClose);
			try {
				const result = await deps.service.exportAssets({
					outDir: nasPath,
					year,
					dryRun: body.dryRun ?? false,
					signal: ac.signal,
				});
				sendOk<ExportResult>(reply, result);
			} finally {
				request.raw.off('aborted', onClose);
				reply.raw.off('close', onClose);
			}
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
			const progress = deps.service.getExportProgress();
			sendOk<ExportStatusResponse>(reply, { running: progress !== null, progress });
		},
	);
	};
}
