import type { FastifyInstance } from 'fastify';
import { sendOk } from '../../../shared/http.js';
import { parseIntParam } from '../../../shared/validation.js';
import { requireRole } from '../../../plugins/auth.js';
import * as bannedIpService from './service.js';

/** Register banned-IP management routes (OPERATOR/ADMIN only) */
export async function bannedIpController(app: FastifyInstance): Promise<void> {
	/** GET /banned-ips — list all banned IPs */
	app.get(
		'/banned-ips',
		{ preHandler: requireRole('ADMIN', 'OPERATOR') },
		async (_request, reply) => {
			const items = await bannedIpService.listBannedIps();
			sendOk(reply, { items });
		},
	);

	/** DELETE /banned-ips/:id — unban an IP */
	app.delete<{ Params: { id: string } }>(
		'/banned-ips/:id',
		{ preHandler: requireRole('ADMIN', 'OPERATOR') },
		async (request, reply) => {
			const id = parseIntParam(request.params.id);
			await bannedIpService.unbanIp(id);
			reply.status(204).send();
		},
	);
}
