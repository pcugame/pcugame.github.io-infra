import type { FastifyInstance } from 'fastify';
import type { ExportResult, ExportStatusResponse } from '@pcu/contracts';
import { sendOk } from '../../../shared/http.js';
import { requireRole } from '../../../plugins/auth.js';
import { badRequest } from '../../../shared/errors.js';
import { env } from '../../../config/env.js';
import { exportService } from './runtime.js';

export async function exportController(app: FastifyInstance): Promise<void> {
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
			const nasPath = env().NAS_EXPORT_PATH;
			if (!nasPath) throw badRequest('NAS_EXPORT_PATH is not configured');

			const body = (request.body ?? {});
			const year = body.year ? Number(body.year) : undefined;
			if (year != null && (!Number.isInteger(year) || year < 2000)) {
				throw badRequest('Invalid year');
			}

			// Build an AbortController tied to the client connection
			const ac = new AbortController();
			request.raw.once('close', () => {
				if (!reply.sent) ac.abort();
			});

			const result = await exportService.exportAssets({
				outDir: nasPath,
				year,
				dryRun: body.dryRun ?? false,
				signal: ac.signal,
			});

			sendOk<ExportResult>(reply, result);
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
			const progress = exportService.getExportProgress();
			sendOk<ExportStatusResponse>(reply, { running: progress !== null, progress });
		},
	);
}
