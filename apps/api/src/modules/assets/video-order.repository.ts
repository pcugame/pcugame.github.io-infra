import type { Prisma } from '../../generated/prisma/client.js';
import { assertVideoCount, normalizedVideoOrder, videoOrderNeedsRewrite } from './video-order.policy.js';



/** Callers hold the project row lock throughout every read/write operation. */
export async function getProjectVideos(tx: Prisma.TransactionClient, projectId: number) {
	return tx.asset.findMany({
		where: { projectId, kind: 'VIDEO', status: 'READY' },
		select: { id: true, videoSortOrder: true, createdAt: true },
		orderBy: [{ videoSortOrder: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
	});
}

export async function rewriteProjectVideoOrder(tx: Prisma.TransactionClient, projectId: number, ids: readonly number[]): Promise<void> {
	assertVideoCount(ids.length);
	await tx.asset.updateMany({
		where: { projectId, kind: 'VIDEO', status: 'READY' },
		data: { videoSortOrder: null },
	});
	for (const [videoSortOrder, id] of ids.entries()) {
		await tx.asset.update({ where: { id }, data: { videoSortOrder } });
	}
}

export async function normalizeProjectVideoOrder(tx: Prisma.TransactionClient, projectId: number) {
	const videos = await getProjectVideos(tx, projectId);
	assertVideoCount(videos.length);
	if (videoOrderNeedsRewrite(videos)) {
		await rewriteProjectVideoOrder(tx, projectId, videos.map(({ id }) => id));
	}
	return normalizedVideoOrder(videos);
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
