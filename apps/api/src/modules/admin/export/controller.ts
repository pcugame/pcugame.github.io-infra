import type { FastifyInstance } from 'fastify';
import { sendOk } from '../../../shared/http.js';
import { requireRole } from '../../../plugins/auth.js';
import { badRequest } from '../../../shared/errors.js';
import { env } from '../../../config/env.js';
import * as exportService from './service.js';

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

			const body = (request.body ?? {}) as { year?: number; dryRun?: boolean };
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

			sendOk(reply, result);
		},
	);
}
