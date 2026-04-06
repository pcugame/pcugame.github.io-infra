import type { FastifyInstance } from 'fastify';
import { sendOk } from '../../../shared/http.js';
import { requireRole } from '../../../plugins/auth.js';
import * as settingsService from './service.js';

/** Register site-settings management routes (OPERATOR/ADMIN only) */
export async function settingsController(app: FastifyInstance): Promise<void> {
	/** GET /settings — current site settings */
	app.get(
		'/settings',
		{ preHandler: requireRole('ADMIN', 'OPERATOR') },
		async (_request, reply) => {
			const settings = await settingsService.getSettings();
			sendOk(reply, settings);
		},
	);

	/** PATCH /settings — update site settings */
	app.patch(
		'/settings',
		{ preHandler: requireRole('ADMIN', 'OPERATOR') },
		async (request, reply) => {
			const updated = await settingsService.updateSettings(
				request.body as Record<string, unknown> | null,
			);
			sendOk(reply, updated);
		},
	);
}
