import type { PrismaClient } from '../../../generated/prisma/client.js';

export function createBannedIpRepository(client: PrismaClient) {
	return {
		/** List all banned IPs, newest first. */
		findAllBannedIps: () => client.bannedIp.findMany({ orderBy: { createdAt: 'desc' } }),

		/** Find a banned IP record by primary key. */
		findBannedIpById: (id: number) => client.bannedIp.findUnique({ where: { id } }),

		/** Delete a banned IP record by primary key. */
		deleteBannedIp: (id: number) => client.bannedIp.delete({ where: { id } }),
	};
}
