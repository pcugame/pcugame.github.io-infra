import type { FastifyInstance } from 'fastify';
import { sendOk } from '../../shared/http.js';
import { badRequest } from '../../shared/errors.js';
import { requireRole } from '../../plugins/auth.js';
import { getSiteSettings, updateSiteSettings } from '../../shared/site-settings.js';

export async function adminSettingsRoutes(app: FastifyInstance): Promise<void> {
	// GET /settings — current site settings
	app.get(
		'/settings',
		{ preHandler: requireRole('ADMIN', 'OPERATOR') },
		async (_request, reply) => {
			const settings = await getSiteSettings();
			sendOk(reply, settings);
		},
	);

	// PATCH /settings — update site settings
	app.patch(
		'/settings',
		{ preHandler: requireRole('ADMIN', 'OPERATOR') },
		async (request, reply) => {
			const body = request.body as Record<string, unknown> | null;
			if (!body) throw badRequest('Missing body');

			const patch: { maxGameFileMb?: number; maxChunkSizeMb?: number } = {};

			if (body.maxGameFileMb !== undefined) {
				const v = Number(body.maxGameFileMb);
				if (!Number.isInteger(v) || v < 1) throw badRequest('maxGameFileMb must be a positive integer');
				patch.maxGameFileMb = v;
			}

			if (body.maxChunkSizeMb !== undefined) {
				const v = Number(body.maxChunkSizeMb);
				if (!Number.isInteger(v) || v < 1 || v > 100) throw badRequest('maxChunkSizeMb must be 1–100');
				patch.maxChunkSizeMb = v;
			}

			if (Object.keys(patch).length === 0) throw badRequest('No valid fields to update');

			const updated = await updateSiteSettings(patch);
			sendOk(reply, updated);
		},
	);
}
