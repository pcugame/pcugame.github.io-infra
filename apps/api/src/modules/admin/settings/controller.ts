import type { FastifyPluginAsync } from 'fastify';
import type { SiteSettingsData } from '@pcu/contracts';
import { sendOk } from '../../../shared/http.js';
import { requireRole } from '../../../plugins/auth.js';
import type { createSettingsService } from './service.js';

export function createSettingsController(deps: {
	service: ReturnType<typeof createSettingsService>;
}): FastifyPluginAsync {
	return async function settingsController(app): Promise<void> {
		app.get(
			'/settings',
			{ preHandler: requireRole('ADMIN', 'OPERATOR') },
			async (_request, reply) => {
				sendOk<SiteSettingsData>(reply, await deps.service.getSettings());
			},
		);
		app.patch(
			'/settings',
			{ preHandler: requireRole('ADMIN', 'OPERATOR') },
			async (request, reply) => {
				const updated = await deps.service.updateSettings(
					request.body as Record<string, unknown> | null,
				);
				sendOk<SiteSettingsData>(reply, updated);
			},
		);
	};
}
