import type { PrismaClient } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';

export function createAssetsRepository(client: PrismaClient) {
	return {
		/** Find a public, READY asset by storageKey */
		findPublicAsset(storageKey: string) {
			return client.asset.findFirst({
				where: { storageKey, isPublic: true, status: 'READY' },
			});
		},

		/** Find any READY asset by storageKey (including protected) */
		findAssetByStorageKey(storageKey: string) {
			return client.asset.findFirst({
				where: {
					status: 'READY',
					OR: [
						{ storageKey },
						{ playbackStorageKey: storageKey },
					],
				},
				include: {
					project: {
						select: {
							creatorId: true,
							title: true,
							status: true,
							members: {
								select: { id: true, userId: true, name: true, studentId: true, sortOrder: true },
								orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
							},
						},
					},
				},
			});
		},

		/** Find an asset by ID with its project relation */
		findAssetByIdWithProject(id: number) {
			return client.asset.findUnique({
				where: { id },
				include: { project: true },
			});
		},

		/** Mark an asset as DELETING */
		markAssetDeleting(id: number) {
			return client.asset.update({ where: { id }, data: { status: 'DELETING' } });
		},

		/** Mark an asset as DELETED */
		markAssetDeleted(id: number) {
			return client.asset.update({ where: { id }, data: { status: 'DELETED' } });
		},

		/** Clear poster reference only if it still matches the deleted asset. */
		clearPosterIfMatches(projectId: number, assetId: number) {
			return client.project.updateMany({
				where: { id: projectId, posterAssetId: assetId },
				data: { posterAssetId: null },
			});
		},

		/** Upsert a banned IP record */
		upsertBannedIp(ip: string, reason: string) {
			return client.bannedIp.upsert({
				where: { ip },
				create: { ip, reason },
				update: {},
			});
		},

		/** Load all banned IPs (for in-memory cache init) */
		findAllBannedIps() {
			return client.bannedIp.findMany({ select: { ip: true } });
		},
	};
}

export const {
	findPublicAsset,
	findAssetByStorageKey,
	findAssetByIdWithProject,
	markAssetDeleting,
	markAssetDeleted,
	clearPosterIfMatches,
	upsertBannedIp,
	findAllBannedIps,
} = createAssetsRepository(prisma);
