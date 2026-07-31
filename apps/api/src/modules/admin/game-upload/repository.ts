import {
	Prisma,
	type AssetKind,
	type AssetPlaybackStatus,
	type PrismaClient,
	type UploadKind,
} from '../../../generated/prisma/client.js';
import { ActiveUploadCompletionInProgressError } from './ports.js';
import { queueDurableDeletions } from '../../orphan/outbox.js';
import { webglDeletionTargetsByEntry } from '../../webgl/deletion-targets.js';
import {
	ASSET_MUTATION_TRANSACTION_POLICY,
	withAssetMutationTransaction,
} from '../../assets/mutation-transaction.js';

type TxClient = Prisma.TransactionClient;

export interface GameReplacementOutboxConfig {
	bucket: string;
	reason: string;
	playbackReason: string;
}

export interface WebglReplacementOutboxConfig {
	publicBucket: string;
	protectedBucket: string;
	reason: string;
}

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
	client: PrismaClient,
	maxAttempts = 3,
): Promise<T> {
	let lastErr: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			return await client.$transaction(fn, serializableOptions);
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
export function findSessionById(
	id: string,
	client: PrismaClient,
): Promise<UploadSessionRecord | null> {
	return client.gameUploadSession.findUnique({
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
export function createSessionReplacingActive(
	data: CreateSessionData,
	client: PrismaClient,
) {
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
	}, client);
}

/** Update session status (e.g. cancel, expire) */
export function updateSessionStatus(id: string, status: string, client: PrismaClient) {
	return client.gameUploadSession.update({
		where: { id },
		data: { status },
	});
}

export function cancelSessionAndClearActive(id: string, client: PrismaClient) {
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
	}, client);
}

/** Find all active (PENDING/COMPLETING) sessions for a project */
export function findActiveSessions(projectId: number, client: PrismaClient) {
	return client.gameUploadSession.findMany({
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
	client: PrismaClient,
): Promise<UploadSessionWithParts[]> {
	return client.gameUploadSession.findMany({
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
export function transitionToCompleting(sessionId: string, client: PrismaClient) {
	return client.gameUploadSession.updateMany({
		where: { id: sessionId, status: 'PENDING' },
		data: { status: 'COMPLETING' },
	});
}

/** Store or replace an S3 multipart ETag for a part. */
export async function upsertPartEtag(
	sessionId: string,
	partNumber: number,
	etag: string,
	client: PrismaClient,
) {
	await client.gameUploadPart.upsert({
		where: {
			game_upload_part_session_part: {
				sessionId,
				partNumber,
			},
		},
		update: { etag },
		create: { sessionId, partNumber, etag },
	});
	return client.gameUploadPart.findMany({
		where: { sessionId },
		orderBy: { partNumber: 'asc' },
	});
}

export function findPartsBySessionId(sessionId: string, client: PrismaClient) {
	return client.gameUploadPart.findMany({
		where: { sessionId },
		orderBy: { partNumber: 'asc' },
	});
}

/** Revert a COMPLETING session back to PENDING (for retry on error) */
export function revertToPending(sessionId: string, client: PrismaClient) {
	return client.gameUploadSession.updateMany({
		where: { id: sessionId, status: 'COMPLETING' },
		data: { status: 'PENDING' },
	});
}

export function markFailed(
	sessionId: string,
	storageKey: string | null | undefined,
	client: PrismaClient,
) {
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
	}, client);
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
	outbox: GameReplacementOutboxConfig,
	client: PrismaClient,
): Promise<{ assetId: number; oldStorageKey: string | null; oldPlaybackStorageKey: string | null }> {
	return withAssetMutationTransaction(client, async (tx) => {
		const projects = await tx.$queryRaw<Array<{ id: number }>>(Prisma.sql`
			SELECT "id"
			FROM "projects"
			WHERE "id" = ${projectId}
			FOR UPDATE
		`);
		if (projects.length === 0) throw new Error('Project no longer exists');
		const existingRows = await tx.$queryRaw<Array<{
			id: number;
			storageKey: string;
			playbackStorageKey: string | null;
		}>>(Prisma.sql`
			SELECT
				"id",
				"storage_key" AS "storageKey",
				"playback_storage_key" AS "playbackStorageKey"
			FROM "assets"
			WHERE "project_id" = ${projectId}
				AND "kind" = CAST(${kind} AS "AssetKind")
				AND "status" = 'READY'
			ORDER BY "id"
			LIMIT 1
			FOR UPDATE
		`);
		const existing = existingRows[0] ?? null;

		let result: { assetId: number; oldStorageKey: string | null; oldPlaybackStorageKey: string | null };
		if (existing) {
			await queueDurableDeletions(tx, [
				...(existing.storageKey !== data.storageKey
					? [{ bucket: outbox.bucket, storageKey: existing.storageKey, reason: outbox.reason }]
					: []),
				...(existing.playbackStorageKey
					&& existing.playbackStorageKey !== data.playbackStorageKey
					&& existing.playbackStorageKey !== data.storageKey
					? [{
						bucket: outbox.bucket,
						storageKey: existing.playbackStorageKey,
						reason: outbox.playbackReason,
					}]
					: []),
			]);
			await tx.project.updateMany({
				where: { id: projectId, posterAssetId: existing.id },
				data: { posterAssetId: null },
			});
			await tx.asset.update({
				where: { id: existing.id },
				data: { status: 'DELETED' },
				select: { id: true },
			});
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
			result = {
				assetId: created.id,
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
	}, ASSET_MUTATION_TRANSACTION_POLICY);
}

export function finalizeCompletedWebglSession(
	sessionId: string,
	projectId: number,
	entryKey: string,
	sourceKey: string,
	outbox: WebglReplacementOutboxConfig,
	client: PrismaClient,
): Promise<{ oldEntryKey: string }> {
	return withSerializableRetry(async (tx) => {
		const project = await tx.project.findUniqueOrThrow({
			where: { id: projectId },
			select: { webglEntryKey: true },
		});
		await queueDurableDeletions(tx, webglDeletionTargetsByEntry(
			projectId,
			project.webglEntryKey === entryKey ? '' : project.webglEntryKey,
			outbox,
			outbox.reason,
		));
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
	}, client);
}

/**
 * Find sessions stuck in COMPLETING past `cutoff` — these were interrupted by a crash
 * or forced shutdown and would otherwise never progress. Called on boot so a restart
 * gives users a chance to retry rather than waiting for TTL expiry.
 */
export function findStaleCompletingSessions(cutoff: Date, client: PrismaClient) {
	return client.gameUploadSession.findMany({
		where: { status: 'COMPLETING', updatedAt: { lt: cutoff } },
	});
}

/** Find an exhibition by ID */
export function findExhibitionById(id: number, client: PrismaClient) {
	return client.exhibition.findUnique({ where: { id } });
}

/**
 * Bind every game-upload query and transaction to one context-owned Prisma
 * client. No query helper reaches a process-global client.
 */
export function createGameUploadRepository(client: PrismaClient) {
	return {
		findSessionById: (id: string) => findSessionById(id, client),
		createSessionReplacingActive: (data: CreateSessionData) => (
			createSessionReplacingActive(data, client)
		),
		cancelSessionAndClearActive: (id: string) => cancelSessionAndClearActive(id, client),
		upsertPartEtag: (
			sessionId: string,
			partNumber: number,
			etag: string,
		) => upsertPartEtag(sessionId, partNumber, etag, client),
		transitionToCompleting: (sessionId: string) => transitionToCompleting(sessionId, client),
		findPartsBySessionId: (sessionId: string) => findPartsBySessionId(sessionId, client),
		revertToPending: (sessionId: string) => revertToPending(sessionId, client),
		markFailed: (sessionId: string, storageKey?: string | null) => (
			markFailed(sessionId, storageKey, client)
		),
		findStaleCompletingSessions: (cutoff: Date) => findStaleCompletingSessions(cutoff, client),
		findActiveSessionsForListing: (
			projectId: number,
			options: { userId?: number },
		) => findActiveSessionsForListing(projectId, options, client),
		findExhibitionById: (id: number) => findExhibitionById(id, client),
		finalizeCompletedSession: (
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
			outbox: GameReplacementOutboxConfig,
		) => finalizeCompletedSession(
			sessionId,
			projectId,
			kind,
			data,
			outbox,
			client,
		),
		finalizeCompletedWebglSession: (
			sessionId: string,
			projectId: number,
			entryKey: string,
			sourceKey: string,
			outbox: WebglReplacementOutboxConfig,
		) => finalizeCompletedWebglSession(
			sessionId,
			projectId,
			entryKey,
			sourceKey,
			outbox,
			client,
		),
	};
}
