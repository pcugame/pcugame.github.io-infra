import { Prisma } from '../../generated/prisma/client.js';
import { conflict } from '../../shared/errors.js';

export const MAX_PROJECT_VIDEOS = 5;

/** Callers hold the project row lock throughout every read/write operation. */
export async function getProjectVideos(tx: Prisma.TransactionClient, projectId: number) {
	return tx.asset.findMany({
		where: { projectId, kind: 'VIDEO', status: 'READY' },
		select: { id: true, videoSortOrder: true, createdAt: true },
		orderBy: [{ videoSortOrder: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
	});
}

export async function rewriteProjectVideoOrder(tx: Prisma.TransactionClient, projectId: number, ids: readonly number[]): Promise<void> {
	if (ids.length > MAX_PROJECT_VIDEOS) throw conflict('A project supports at most 5 videos');
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
	if (videos.length > MAX_PROJECT_VIDEOS) throw conflict('A project supports at most 5 videos');
	if (videos.some((video, index) => video.videoSortOrder !== index)) {
		await rewriteProjectVideoOrder(tx, projectId, videos.map(({ id }) => id));
	}
	return videos.map((video, videoSortOrder) => ({ ...video, videoSortOrder }));
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

/** Appends under the same owner lock used by direct allocations, reorders and deletions. */
export async function nextProjectVideoOrder(tx: Prisma.TransactionClient, projectId: number, excludeSessionId?: string): Promise<number> {
	await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "projects" WHERE "id" = ${projectId} FOR UPDATE`);
	const videos = await normalizeProjectVideoOrder(tx, projectId);
	const reserved = await countReservedProjectVideos(tx, projectId, excludeSessionId);
	if (videos.length + reserved >= MAX_PROJECT_VIDEOS) throw conflict('A project supports at most 5 videos');
	return videos.length;
}
