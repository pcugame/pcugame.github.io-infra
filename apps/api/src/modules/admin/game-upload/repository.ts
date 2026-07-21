import { prisma } from '../../../lib/prisma.js';
import { Prisma, type AssetKind, type AssetPlaybackStatus, type UploadKind } from '../../../generated/prisma/client.js';

type TxClient = Prisma.TransactionClient;

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
export function findSessionById(id: string): Promise<any> {
	return prisma.gameUploadSession.findUnique({
		where: { id },
		include: {
			project: {
				select: {
					status: true,
				},
			},
			parts: {
				orderBy: { partNumber: 'asc' },
			},
		},
	} as any) as Promise<any>;
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
		const active = await (tx as any).gameUploadActiveSession.findUnique({
			where: {
				projectId_uploadKind: {
					projectId: data.projectId,
					uploadKind: data.uploadKind,
				},
			},
			include: { session: true },
		});
		const replacedSessions = active?.session ? [active.session] : [];

		if (active) {
			await tx.gameUploadSession.updateMany({
				where: {
					id: active.sessionId,
					status: { in: ['PENDING', 'COMPLETING'] },
				},
				data: { status: 'CANCELLED' },
			});
		}

		const session = await tx.gameUploadSession.create({ data });
		await (tx as any).gameUploadActiveSession.upsert({
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
		const session = await tx.gameUploadSession.update({
			where: { id },
			data: { status: 'CANCELLED' },
		});
		await (tx as any).gameUploadActiveSession.deleteMany({
			where: { sessionId: id },
		});
		return session;
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
		include: {
			parts: {
				orderBy: { partNumber: 'asc' },
			},
		},
		orderBy: { createdAt: 'desc' },
	} as any) as Promise<any[]>;
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
	await (prisma as any).gameUploadPart.upsert({
		where: {
			game_upload_part_session_part: {
				sessionId,
				partNumber,
			},
		},
		update: { etag },
		create: { sessionId, partNumber, etag },
	});
	return (prisma as any).gameUploadPart.findMany({
		where: { sessionId },
		orderBy: { partNumber: 'asc' },
	}) as Promise<Array<{ partNumber: number; etag: string }>>;
}

export function findPartsBySessionId(sessionId: string) {
	return (prisma as any).gameUploadPart.findMany({
		where: { sessionId },
		orderBy: { partNumber: 'asc' },
	}) as Promise<Array<{ partNumber: number; etag: string }>>;
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
			where: { id: sessionId },
			data: {
				status: 'FAILED',
				...(storageKey ? { storageKey } : {}),
			},
		});
		await (tx as any).gameUploadActiveSession.deleteMany({
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

		await tx.gameUploadSession.update({
			where: { id: sessionId },
			data: { status: 'COMPLETED', storageKey: data.storageKey },
		});
		await (tx as any).gameUploadActiveSession.deleteMany({
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
		await (tx as any).gameUploadActiveSession.deleteMany({
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
