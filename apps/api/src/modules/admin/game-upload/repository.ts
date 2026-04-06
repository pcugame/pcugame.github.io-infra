import { prisma } from '../../../lib/prisma.js';

/** Find a game upload session by ID */
export function findSessionById(id: string) {
	return prisma.gameUploadSession.findUnique({ where: { id } });
}

/** Create a new game upload session */
export function createSession(data: {
	id: string;
	projectId: number;
	userId: number;
	originalName: string;
	totalBytes: bigint;
	chunkSizeBytes: number;
	totalChunks: number;
	stagingPath: string;
	expiresAt: Date;
}) {
	return prisma.gameUploadSession.create({ data });
}

/** Update session status (e.g. cancel, expire) */
export function updateSessionStatus(id: string, status: string) {
	return prisma.gameUploadSession.update({
		where: { id },
		data: { status },
	});
}

/** Find all active (PENDING/COMPLETING) sessions for a project */
export function findActiveSessions(projectId: number) {
	return prisma.gameUploadSession.findMany({
		where: {
			projectId,
			status: { in: ['PENDING', 'COMPLETING'] },
		},
	});
}

/** Find active sessions for a project, optionally filtered by user */
export function findActiveSessionsForListing(
	projectId: number,
	opts: { userId?: number },
) {
	return prisma.gameUploadSession.findMany({
		where: {
			projectId,
			status: { in: ['PENDING', 'COMPLETING'] },
			...(opts.userId ? { userId: opts.userId } : {}),
		},
		orderBy: { createdAt: 'desc' },
	});
}

/**
 * Atomically append a chunk index to the session's uploadedChunks array.
 * Uses raw SQL to avoid lost-update races on concurrent chunk uploads.
 */
export function appendChunkIndex(sessionId: string, index: number) {
	return prisma.$queryRaw<{ uploaded_chunks: number[] }[]>`
		UPDATE game_upload_sessions
		SET uploaded_chunks = (
			SELECT ARRAY(
				SELECT DISTINCT unnest(uploaded_chunks || ARRAY[${index}::int])
				ORDER BY 1
			)
		),
		updated_at = NOW()
		WHERE id = ${sessionId}
		RETURNING uploaded_chunks
	`;
}

/**
 * Atomically transition session from PENDING to COMPLETING.
 * Returns count=0 if another request already transitioned it.
 */
export function transitionToCompleting(sessionId: string) {
	return prisma.gameUploadSession.updateMany({
		where: { id: sessionId, status: 'PENDING' },
		data: { status: 'COMPLETING' },
	});
}

/** Mark session as COMPLETED and store the final storage key */
export function markCompleted(sessionId: string, storageKey: string) {
	return prisma.gameUploadSession.update({
		where: { id: sessionId },
		data: { status: 'COMPLETED', storageKey },
	});
}

/** Revert a COMPLETING session back to PENDING (for retry on error) */
export function revertToPending(sessionId: string) {
	return prisma.gameUploadSession.updateMany({
		where: { id: sessionId, status: 'COMPLETING' },
		data: { status: 'PENDING' },
	});
}

/** Find an exhibition by ID */
export function findExhibitionById(id: number) {
	return prisma.exhibition.findUnique({ where: { id } });
}

/** Find the first READY GAME asset for a project */
export function findReadyGameAsset(projectId: number) {
	return prisma.asset.findFirst({
		where: { projectId, kind: 'GAME', status: 'READY' },
	});
}

/** Update an existing asset's file metadata */
export function updateAssetFile(
	id: number,
	data: { storageKey: string; originalName: string; mimeType: string; sizeBytes: bigint },
) {
	return prisma.asset.update({ where: { id }, data });
}

/** Create a new GAME asset */
export function createGameAsset(data: {
	projectId: number;
	storageKey: string;
	originalName: string;
	sizeBytes: bigint;
}) {
	return prisma.asset.create({
		data: {
			...data,
			kind: 'GAME',
			mimeType: 'application/zip',
			isPublic: false,
		},
	});
}
