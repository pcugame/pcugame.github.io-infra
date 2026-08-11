import type { FastifyPluginAsync } from 'fastify';
import type { BannedIpListResponse } from '@pcu/contracts';
import { sendOk } from '../../../shared/http.js';
import { parseIntParam } from '../../../shared/validation.js';
import { requireRole } from '../../../plugins/auth.js';
import type { createBannedIpService } from './service.js';

export interface BannedIpControllerDependencies {
	service: ReturnType<typeof createBannedIpService>;
}

/** Create a pure banned-IP route plugin. Registration never loads the DB cache. */
export function createBannedIpController(deps: BannedIpControllerDependencies): FastifyPluginAsync {
	return async function bannedIpController(app): Promise<void> {
		/** GET /banned-ips — list all banned IPs */
		app.get(
			'/banned-ips',
			{ preHandler: requireRole('ADMIN', 'OPERATOR') },
			async (_request, reply) => {
				const items = await deps.service.listBannedIps();
				sendOk<BannedIpListResponse>(reply, { items });
			},
		);

		/** DELETE /banned-ips/:id — unban an IP */
		app.delete<{ Params: { id: string } }>(
			'/banned-ips/:id',
			{ preHandler: requireRole('ADMIN', 'OPERATOR') },
			async (request, reply) => {
				const id = parseIntParam(request.params.id);
				await deps.service.unbanIp(id);
				reply.status(204).send();
			},
		);
	};
}
