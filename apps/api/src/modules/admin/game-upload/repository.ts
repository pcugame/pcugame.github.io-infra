import { prisma } from '../../../lib/prisma.js';
import { Prisma, type AssetKind, type AssetPlaybackStatus, type UploadKind } from '../../../generated/prisma/client.js';
import { ActiveUploadCompletionInProgressError } from './ports.js';

type TxClient = Prisma.TransactionClient;

const sessionWithProjectAndParts = {
	include: {
		project: { select: { status: true } },
		parts: { orderBy: { partNumber: 'asc' as const } },
	},
} satisfies Prisma.GameUploadSessionDefaultArgs;

export type UploadSessionRecord = Prisma.GameUploadSessionGetPayload<
	typeof sessionWithProjectAndParts
>;

const sessionWithParts = {
	include: { parts: { orderBy: { partNumber: 'asc' as const } } },
} satisfies Prisma.GameUploadSessionDefaultArgs;

export type UploadSessionWithParts = Prisma.GameUploadSessionGetPayload<
	typeof sessionWithParts
>;

const serializableOptions = {
	isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
} as const;

function isRetryableTransactionError(err: unknown): boolean {
	return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034';
}

export async function withSerializableRetry<T>(
	fn: (tx: TxClient) => Promise<T>,
	maxAttempts = 3,
): Promise<T> {
	let lastErr: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			return await prisma.$transaction(fn, serializableOptions);
		} catch (err) {
			lastErr = err;
			if (!isRetryableTransactionError(err) || attempt === maxAttempts) {
				throw err;
			}
		}
	}
	throw lastErr;
}

/** Find a game upload session by ID */
export function findSessionById(id: string): Promise<UploadSessionRecord | null> {
	return prisma.gameUploadSession.findUnique({
		where: { id },
		...sessionWithProjectAndParts,
	});
}

type CreateSessionData = {
	id: string;
	projectId: number;
	userId: number;
	uploadKind: UploadKind;
	originalName: string;
	totalBytes: bigint;
	chunkSizeBytes: number;
	totalChunks: number;
	s3UploadId: string;
	s3Key: string;
	expiresAt: Date;
};

/** Create a new session and replace the project's active slot atomically. */
export function createSessionReplacingActive(data: CreateSessionData) {
	return withSerializableRetry(async (tx) => {
		const active = await tx.gameUploadActiveSession.findUnique({
			where: {
				projectId_uploadKind: {
					projectId: data.projectId,
					uploadKind: data.uploadKind,
				},
			},
			include: { session: true },
		});
		const replacedSessions = active?.session ? [active.session] : [];

		// A completing upload may already have committed its multipart object. It
		// must retain the active slot until finalization/recovery reaches a terminal
		// state; cancelling it here would strand that object outside recovery.
		if (active?.session.status === 'COMPLETING') {
			throw new ActiveUploadCompletionInProgressError();
		}

		if (active) {
			await tx.gameUploadSession.updateMany({
				where: {
					id: active.sessionId,
					status: 'PENDING',
				},
				data: { status: 'CANCELLED' },
			});
		}

		const session = await tx.gameUploadSession.create({ data });
		await tx.gameUploadActiveSession.upsert({
			where: {
				projectId_uploadKind: {
					projectId: data.projectId,
					uploadKind: data.uploadKind,
				},
			},
			update: { sessionId: session.id },
			create: {
				projectId: data.projectId,
				uploadKind: data.uploadKind,
				sessionId: session.id,
			},
		});

		return { session, replacedSessions };
	});
}

/** Update session status (e.g. cancel, expire) */
export function updateSessionStatus(id: string, status: string) {
	return prisma.gameUploadSession.update({
		where: { id },
		data: { status },
	});
}

export function cancelSessionAndClearActive(id: string) {
	return withSerializableRetry(async (tx) => {
		const result = await tx.gameUploadSession.updateMany({
			where: { id, status: 'PENDING' },
			data: { status: 'CANCELLED' },
		});
		if (result.count === 1) {
			await tx.gameUploadActiveSession.deleteMany({
				where: { sessionId: id },
			});
		}
		return result;
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
): Promise<UploadSessionWithParts[]> {
	return prisma.gameUploadSession.findMany({
		where: {
			projectId,
			status: { in: ['PENDING', 'COMPLETING'] },
			...(opts.userId ? { userId: opts.userId } : {}),
		},
		...sessionWithParts,
		orderBy: { createdAt: 'desc' },
	});
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

/** Store or replace an S3 multipart ETag for a part. */
export async function upsertPartEtag(
	sessionId: string,
	partNumber: number,
	etag: string,
) {
	await prisma.gameUploadPart.upsert({
		where: {
			game_upload_part_session_part: {
				sessionId,
				partNumber,
			},
		},
		update: { etag },
		create: { sessionId, partNumber, etag },
	});
	return prisma.gameUploadPart.findMany({
		where: { sessionId },
		orderBy: { partNumber: 'asc' },
	});
}

export function findPartsBySessionId(sessionId: string) {
	return prisma.gameUploadPart.findMany({
		where: { sessionId },
		orderBy: { partNumber: 'asc' },
	});
}

/** Revert a COMPLETING session back to PENDING (for retry on error) */
export function revertToPending(sessionId: string) {
	return prisma.gameUploadSession.updateMany({
		where: { id: sessionId, status: 'COMPLETING' },
		data: { status: 'PENDING' },
	});
}

export function markFailed(sessionId: string, storageKey?: string | null) {
	return withSerializableRetry(async (tx) => {
		const result = await tx.gameUploadSession.updateMany({
			where: { id: sessionId, status: { in: ['PENDING', 'COMPLETING'] } },
			data: {
				status: 'FAILED',
				...(storageKey ? { storageKey } : {}),
			},
		});
		await tx.gameUploadActiveSession.deleteMany({
			where: { sessionId },
		});
		return result;
	});
}

export function finalizeCompletedSession(
	sessionId: string,
	projectId: number,
	kind: AssetKind,
	data: {
		storageKey: string;
		playbackStorageKey?: string | null;
		originalName: string;
		mimeType: string;
		playbackMimeType?: string;
		sizeBytes: bigint;
		playbackSizeBytes?: bigint;
		playbackStatus?: AssetPlaybackStatus;
		playbackError?: string;
		isPublic: boolean;
	},
): Promise<{ assetId: number; oldStorageKey: string | null; oldPlaybackStorageKey: string | null }> {
	return withSerializableRetry(async (tx) => {
		const existing = await tx.asset.findFirst({
			where: { projectId, kind, status: 'READY' },
			select: { id: true, storageKey: true, playbackStorageKey: true },
		});

		let result: { assetId: number; oldStorageKey: string | null; oldPlaybackStorageKey: string | null };
		if (existing) {
			const updated = await tx.asset.update({
				where: { id: existing.id },
				data: {
					storageKey: data.storageKey,
					playbackStorageKey: data.playbackStorageKey ?? null,
					originalName: data.originalName,
					mimeType: data.mimeType,
					playbackMimeType: data.playbackMimeType ?? '',
					sizeBytes: data.sizeBytes,
					playbackSizeBytes: data.playbackSizeBytes ?? BigInt(0),
					playbackStatus: data.playbackStatus ?? 'PENDING',
					playbackError: data.playbackError ?? '',
					isPublic: data.isPublic,
				},
				select: { id: true },
			});
			result = {
				assetId: updated.id,
				oldStorageKey: existing.storageKey,
				oldPlaybackStorageKey: existing.playbackStorageKey,
			};
		} else {
			const created = await tx.asset.create({
				data: {
					projectId,
					kind,
					storageKey: data.storageKey,
					playbackStorageKey: data.playbackStorageKey ?? null,
					originalName: data.originalName,
					mimeType: data.mimeType,
					playbackMimeType: data.playbackMimeType ?? '',
					sizeBytes: data.sizeBytes,
					playbackSizeBytes: data.playbackSizeBytes ?? BigInt(0),
					playbackStatus: data.playbackStatus ?? 'PENDING',
					playbackError: data.playbackError ?? '',
					isPublic: data.isPublic,
				},
				select: { id: true },
			});
			result = { assetId: created.id, oldStorageKey: null, oldPlaybackStorageKey: null };
		}

		const completed = await tx.gameUploadSession.updateMany({
			where: { id: sessionId, status: 'COMPLETING', uploadKind: 'GAME' },
			data: { status: 'COMPLETED', storageKey: data.storageKey },
		});
		if (completed.count !== 1) {
			throw new Error('Game upload session is no longer completing');
		}
		await tx.gameUploadActiveSession.deleteMany({
			where: { sessionId },
		});

		return result;
	});
}

export function finalizeCompletedWebglSession(
	sessionId: string,
	projectId: number,
	entryKey: string,
	sourceKey: string,
): Promise<{ oldEntryKey: string }> {
	return withSerializableRetry(async (tx) => {
		const project = await tx.project.findUniqueOrThrow({
			where: { id: projectId },
			select: { webglEntryKey: true },
		});
		await tx.project.update({
			where: { id: projectId },
			data: { webglEntryKey: entryKey },
		});
		const completed = await tx.gameUploadSession.updateMany({
			where: { id: sessionId, status: 'COMPLETING', uploadKind: 'WEBGL' },
			data: { status: 'COMPLETED', storageKey: sourceKey },
		});
		if (completed.count !== 1) {
			throw new Error('WebGL upload session is no longer completing');
		}
		await tx.gameUploadActiveSession.deleteMany({
			where: { sessionId },
		});
		return { oldEntryKey: project.webglEntryKey };
	});
}

/**
 * Find sessions stuck in COMPLETING past `cutoff` — these were interrupted by a crash
 * or forced shutdown and would otherwise never progress. Called on boot so a restart
 * gives users a chance to retry rather than waiting for TTL expiry.
 */
export function findStaleCompletingSessions(cutoff: Date) {
	return prisma.gameUploadSession.findMany({
		where: { status: 'COMPLETING', updatedAt: { lt: cutoff } },
	});
}

/** Find an exhibition by ID */
export function findExhibitionById(id: number) {
	return prisma.exhibition.findUnique({ where: { id } });
}
