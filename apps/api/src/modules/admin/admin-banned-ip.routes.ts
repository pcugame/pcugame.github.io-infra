import type { FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { sendOk } from '../../shared/http.js';
import { notFound } from '../../shared/errors.js';
import { requireLogin } from '../../plugins/auth.js';
import { requireRole } from '../../plugins/auth.js';
import { gameDownloadLimiter } from '../assets/assets.routes.js';

export async function adminBannedIpRoutes(app: FastifyInstance): Promise<void> {
	// GET /banned-ips — list all banned IPs
	app.get(
		'/banned-ips',
		{ preHandler: requireRole('ADMIN', 'OPERATOR') },
		async (_request, reply) => {
			const items = await prisma.bannedIp.findMany({
				orderBy: { createdAt: 'desc' },
			});
			sendOk(reply, {
				items: items.map((b) => ({
					id: b.id,
					ip: b.ip,
					reason: b.reason,
					createdAt: b.createdAt.toISOString(),
				})),
			});
		},
	);

	// DELETE /banned-ips/:id — unban an IP
	app.delete<{ Params: { id: string } }>(
		'/banned-ips/:id',
		{ preHandler: requireRole('ADMIN', 'OPERATOR') },
		async (request, reply) => {
			const record = await prisma.bannedIp.findUnique({
				where: { id: request.params.id },
			});
			if (!record) throw notFound('Banned IP record not found');

			await prisma.bannedIp.delete({ where: { id: record.id } });

			// Remove from in-memory cache so the IP can download again immediately
			gameDownloadLimiter.removeBan(record.ip);

			reply.status(204).send();
		},
	);
}
