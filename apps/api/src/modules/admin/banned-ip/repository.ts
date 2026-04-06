import { prisma } from '../../../lib/prisma.js';

/** List all banned IPs, newest first */
export function findAllBannedIps() {
	return prisma.bannedIp.findMany({ orderBy: { createdAt: 'desc' } });
}

/** Find a banned IP record by primary key */
export function findBannedIpById(id: number) {
	return prisma.bannedIp.findUnique({ where: { id } });
}

/** Delete a banned IP record by primary key */
export function deleteBannedIp(id: number) {
	return prisma.bannedIp.delete({ where: { id } });
}
