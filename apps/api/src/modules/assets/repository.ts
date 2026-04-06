import { prisma } from '../../lib/prisma.js';

/** Find a public, READY asset by storageKey */
export function findPublicAsset(storageKey: string) {
	return prisma.asset.findFirst({
		where: { storageKey, isPublic: true, status: 'READY' },
	});
}

/** Find any READY asset by storageKey (including protected) */
export function findAssetByStorageKey(storageKey: string) {
	return prisma.asset.findFirst({
		where: { storageKey, status: 'READY' },
	});
}

/** Find an asset by ID with its project relation */
export function findAssetByIdWithProject(id: number) {
	return prisma.asset.findUnique({
		where: { id },
		include: { project: true },
	});
}

/** Mark an asset as DELETING */
export function markAssetDeleting(id: number) {
	return prisma.asset.update({ where: { id }, data: { status: 'DELETING' } });
}

/** Mark an asset as DELETED */
export function markAssetDeleted(id: number) {
	return prisma.asset.update({ where: { id }, data: { status: 'DELETED' } });
}

/** Clear poster reference if it matches the given asset */
export function clearPosterIfMatches(projectId: number, assetId: number) {
	return prisma.project
		.update({ where: { id: projectId }, data: { posterAssetId: null } })
		.catch(() => {});
}

/** Upsert a banned IP record */
export function upsertBannedIp(ip: string, reason: string) {
	return prisma.bannedIp.upsert({
		where: { ip },
		create: { ip, reason },
		update: {},
	});
}

/** Load all banned IPs (for in-memory cache init) */
export function findAllBannedIps() {
	return prisma.bannedIp.findMany({ select: { ip: true } });
}
