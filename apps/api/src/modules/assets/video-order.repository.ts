import type { Prisma } from '../../generated/prisma/client.js';
import { normalizedVideoOrder, videoOrderNeedsRewrite, orderedProjectVideos, videoOrderAssignments } from './video-order.policy.js';

/** Callers hold the project row lock throughout every read/write operation. */
export async function getProjectVideos(tx: Prisma.TransactionClient, projectId: number) {
	return orderedProjectVideos(await tx.asset.findMany({
		where: { projectId, kind: 'VIDEO', status: 'READY' },
		select: { id: true, videoSortOrder: true, createdAt: true },
	}));
}

export async function rewriteProjectVideoOrder(tx: Prisma.TransactionClient, projectId: number, ids: readonly number[]): Promise<void> {
	const assignments = videoOrderAssignments(ids);
	await tx.asset.updateMany({
		where: { projectId, kind: 'VIDEO', status: 'READY' },
		data: { videoSortOrder: null },
	});
	for (const { videoSortOrder, id } of assignments) {
		await tx.asset.update({ where: { id }, data: { videoSortOrder } });
	}
}

export async function normalizeProjectVideoOrder(tx: Prisma.TransactionClient, projectId: number) {
	const videos = await getProjectVideos(tx, projectId);
	const normalized = normalizedVideoOrder(videos);
	if (videoOrderNeedsRewrite(videos)) {
		await rewriteProjectVideoOrder(tx, projectId, videos.map(({ id }) => id));
	}
	return normalized;
}

/** Result pointers already count as READY assets and must not reserve twice. */
export async function countReservedProjectVideos(tx: Prisma.TransactionClient, projectId: number, excludeSessionId?: string) {
	return tx.assetUploadSession.count({
		where: {
			projectId, kind: 'VIDEO', resultAssetId: null,
			state: { in: ['ALLOCATING', 'UPLOADING', 'COMPLETING', 'VERIFYING'] },
			...(excludeSessionId ? { id: { not: excludeSessionId } } : {}),
		},
	});
}
