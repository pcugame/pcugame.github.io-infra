import { randomUUID } from 'node:crypto';
import {
	Prisma,
	type AssetKind,
	type AssetPlaybackStatus,
	type PrismaClient,
	type UploadKind,
} from '../../../generated/prisma/client.js';
import {
	ActiveUploadCompletionInProgressError,
	type DurablyTrackedMultipartAbort,
	type GameUploadRepository,
} from './ports.js';
import { queueDurableDeletions } from '../../orphan/outbox.js';
import { webglDeletionTargetsByEntry, webglDeletionTargetsBySource } from '../../webgl/deletion-targets.js';
import { parseWebglEntryKey, parseWebglSourceKey } from '../../webgl/paths.js';
import {
	ASSET_MUTATION_TRANSACTION_POLICY,
	withAssetMutationTransaction,
} from '../../assets/mutation-transaction.js';
import { queueMultipartAbortTask } from '../../multipart-abort/repository.js';
import { assertNoDeletionClaim } from '../../orphan/reference-resolver.js';

type TxClient = Prisma.TransactionClient;

async function lockActiveCompletionClaim(
	tx: TxClient,
	sessionId: string,
	token: string,
): Promise<boolean> {
	const active = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
		SELECT "id"
		FROM "game_upload_sessions"
		WHERE "id" = ${sessionId}
			AND "status" = 'COMPLETING'
			AND "completion_claim_token" = ${token}
			AND "completion_claim_until" > clock_timestamp()
		FOR UPDATE
	`);
	return active.length === 1;
}

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
	if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
	if (err.code === 'P2034') return true;
	if (err.code !== 'P2010') return false;
	const driverError = err.meta?.['driverAdapterError'];
	if (!driverError || typeof driverError !== 'object' || !('cause' in driverError)) return false;
	const cause = driverError.cause;
	return !!cause
		&& typeof cause === 'object'
		&& 'kind' in cause
		&& cause.kind === 'TransactionWriteConflict'
		&& 'originalCode' in cause
		&& cause.originalCode === '40001';
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

interface GameUploadRepositoryOptions {
	abortBucket: string;
	publicBucket?: string;
}

/** Create a new session and replace the project's active slot atomically. */
export function createSessionReplacingActive(
	data: CreateSessionData,
	client: PrismaClient,
	abortBucket: string,
	publicBucket?: string,
) {
	return withSerializableRetry(async (tx) => {
		await assertNoDeletionClaim(tx, { bucket: abortBucket, key: data.s3Key });
		if (data.uploadKind === 'WEBGL') {
			if (!publicBucket) throw new Error('WebGL session creation requires a public bucket');
			const keys = parseWebglSourceKey(data.projectId, data.s3Key);
			if (!keys) throw new Error(`Malformed WebGL source key for project ${data.projectId}`);
			await assertNoDeletionClaim(tx, {
				bucket: publicBucket, key: keys.sitePrefix, targetKind: 'PREFIX',
			});
		}
		const active = await tx.gameUploadActiveSession.findUnique({
			where: {
				projectId_uploadKind: {
					projectId: data.projectId,
					uploadKind: data.uploadKind,
				},
			},
			include: { session: true },
		});
		const durableAborts: DurablyTrackedMultipartAbort[] = [];

		// A completing upload may already have committed its multipart object. It
		// must retain the active slot until finalization/recovery reaches a terminal
		// state; cancelling it here would strand that object outside recovery.
		if (active?.session.status === 'COMPLETING') {
			throw new ActiveUploadCompletionInProgressError();
		}

		if (active) {
			if (active.session.s3Key && active.session.s3UploadId) {
				const abort = {
					tracking: 'durable-abort-task-committed' as const,
					sessionId: active.session.id,
					key: active.session.s3Key,
					uploadId: active.session.s3UploadId,
					reason: 'active-upload-replaced',
				};
				await queueMultipartAbortTask(tx, {
					bucket: abortBucket,
					storageKey: abort.key,
					uploadId: abort.uploadId,
					reason: abort.reason,
				});
				durableAborts.push(abort);
			}
			await tx.gameUploadSession.updateMany({
				where: {
					id: active.sessionId,
					status: 'PENDING',
				},
				data: { status: 'CANCELLED', s3UploadId: null, s3Key: null },
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

		return { session, durableAborts };
	}, client);
}

/** Update session status (e.g. cancel, expire) */
export function updateSessionStatus(id: string, status: string, client: PrismaClient) {
	return client.gameUploadSession.update({
		where: { id },
		data: { status },
	});
}

export function cancelSessionAndClearActive(
	id: string,
	client: PrismaClient,
	abortBucket: string,
	reason = 'upload-session-cancelled',
) {
	return withSerializableRetry(async (tx) => {
		const session = await tx.gameUploadSession.findUnique({
			where: { id },
			select: { s3Key: true, s3UploadId: true },
		});
		const result = await tx.gameUploadSession.updateMany({
			where: { id, status: 'PENDING' },
			data: { status: 'CANCELLED', s3UploadId: null, s3Key: null },
		});
		let durableAbort: DurablyTrackedMultipartAbort | null = null;
		if (result.count === 1) {
			if (session?.s3Key && session.s3UploadId) {
				durableAbort = {
					tracking: 'durable-abort-task-committed' as const,
					sessionId: id,
					key: session.s3Key,
					uploadId: session.s3UploadId,
					reason,
				};
				await queueMultipartAbortTask(tx, {
					bucket: abortBucket,
					storageKey: durableAbort.key,
					uploadId: durableAbort.uploadId,
					reason: durableAbort.reason,
				});
			}
			await tx.gameUploadActiveSession.deleteMany({
				where: { sessionId: id },
			});
		}
		return result.count === 1
			? { count: 1 as const, durableAbort }
			: { count: 0 as const, durableAbort: null };
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

export function acquirePartClaim(
	input: {
		sessionId: string;
		partNumber: number;
		generation: number;
		token: string;
		owner: string;
		leaseMs: number;
		contentSha256?: string;
	},
	client: PrismaClient,
) {
	const claimId = randomUUID();
	return withSerializableRetry(async (tx) => {
		const session = await tx.gameUploadSession.findUnique({
			where: { id: input.sessionId },
			select: { status: true, multipartGeneration: true },
		});
		if (!session || session.status !== 'PENDING' || session.multipartGeneration !== input.generation) {
			return { kind: 'unavailable' as const };
		}
		const existingPart = await tx.gameUploadPart.findUnique({
			where: { game_upload_part_session_part: { sessionId: input.sessionId, partNumber: input.partNumber } },
		});
		if (existingPart && existingPart.generation === input.generation) {
			if (input.contentSha256 && existingPart.contentSha256 === input.contentSha256) {
				const parts = await tx.gameUploadPart.findMany({
					where: { sessionId: input.sessionId, generation: input.generation },
					orderBy: { partNumber: 'asc' },
				});
				return { kind: 'already-uploaded' as const, parts };
			}
			return { kind: 'conflict' as const };
		}
		const inserted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
			INSERT INTO "game_upload_part_claims" (
				"id", "session_id", "part_number", "token", "generation",
				"owner", "lease_until", "created_at", "updated_at"
			)
			VALUES (
				${claimId}, ${input.sessionId}, ${input.partNumber}, ${input.token},
				${input.generation}, ${input.owner},
				clock_timestamp() + (${input.leaseMs} * INTERVAL '1 millisecond'),
				clock_timestamp(), clock_timestamp()
			)
			ON CONFLICT ("session_id", "part_number") DO NOTHING
			RETURNING "id"
		`);
		if (inserted.length === 1) {
			return { kind: 'acquired' as const, token: input.token };
		}
		const existing = await tx.$queryRaw<Array<{ expired: boolean }>>(Prisma.sql`
			SELECT claim."lease_until" <= clock_timestamp() AS "expired"
			FROM "game_upload_part_claims" AS claim
			WHERE claim."session_id" = ${input.sessionId}
				AND claim."part_number" = ${input.partNumber}
			FOR UPDATE
		`);
		return existing[0]?.expired
			? { kind: 'expired' as const }
			: { kind: 'busy' as const };
	}, client);
}

export function completePartClaim(
	input: { token: string; etag: string; contentSha256?: string },
	client: PrismaClient,
) {
	return withSerializableRetry(async (tx) => {
		const claims = await tx.$queryRaw<Array<{
			id: string;
			sessionId: string;
			partNumber: number;
			generation: number;
		}>>(Prisma.sql`
			SELECT claim."id",
				claim."session_id" AS "sessionId",
				claim."part_number" AS "partNumber",
				claim."generation"
			FROM "game_upload_part_claims" AS claim
			JOIN "game_upload_sessions" AS session ON session."id" = claim."session_id"
			WHERE claim."token" = ${input.token}
				AND claim."lease_until" > clock_timestamp()
				AND session."status" = 'PENDING'
				AND session."multipart_generation" = claim."generation"
			FOR UPDATE OF claim, session
		`);
		const claim = claims[0];
		if (!claim) {
			return { accepted: false as const, parts: [] };
		}
		const existingPart = await tx.gameUploadPart.findUnique({
			where: {
				game_upload_part_session_part: {
					sessionId: claim.sessionId,
					partNumber: claim.partNumber,
				},
			},
		});
		if (existingPart && existingPart.generation === claim.generation
			&& existingPart.contentSha256 !== input.contentSha256) {
			await tx.gameUploadPartClaim.delete({ where: { id: claim.id } });
			return { accepted: false as const, conflict: true as const, parts: [] };
		}
		await tx.gameUploadPart.upsert({
			where: {
				game_upload_part_session_part: {
					sessionId: claim.sessionId,
					partNumber: claim.partNumber,
				},
			},
			update: { etag: input.etag, generation: claim.generation, contentSha256: input.contentSha256 },
			create: {
				sessionId: claim.sessionId,
				partNumber: claim.partNumber,
				etag: input.etag,
				contentSha256: input.contentSha256,
				generation: claim.generation,
			},
		});
		await tx.gameUploadPartClaim.delete({ where: { id: claim.id } });
		const parts = await tx.gameUploadPart.findMany({
			where: { sessionId: claim.sessionId, generation: claim.generation },
			orderBy: { partNumber: 'asc' },
		});
		return { accepted: true as const, parts };
	}, client);
}

export function claimCompletion(
	input: { sessionId: string; generation: number; token: string; leaseMs: number },
	client: PrismaClient,
) {
	return withSerializableRetry(async (tx) => {
		const session = await tx.gameUploadSession.findUnique({
			where: { id: input.sessionId },
			include: { parts: true, partClaims: true },
		});
		if (!session || session.status !== 'PENDING' || session.multipartGeneration !== input.generation) {
			return { count: 0, reason: 'state' as const };
		}
		const currentParts = session.parts.filter((part) => part.generation === input.generation);
		if (session.partClaims.length > 0) return { count: 0, reason: 'parts-active' as const };
		if (session.sourceIdentityAlgorithm !== 'SHA256_BLOCK_MANIFEST_V1'
			|| !session.sourceIdentity
			|| session.sourceIdentityBlockSizeBytes !== 1048576
			|| !session.sourceIdentityBlockManifest
			|| currentParts.length !== session.totalChunks
			|| currentParts.some((part) => !part.contentSha256)) {
			return { count: 0, reason: 'parts-missing' as const };
		}
		const updated = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
			UPDATE "game_upload_sessions"
			SET "status" = 'COMPLETING',
				"completion_claim_token" = ${input.token},
				"completion_claim_until" = clock_timestamp()
					+ (${input.leaseMs} * INTERVAL '1 millisecond'),
				"completion_last_error" = NULL,
				"updated_at" = clock_timestamp()
			WHERE "id" = ${input.sessionId}
				AND "status" = 'PENDING'
				AND "multipart_generation" = ${input.generation}
			RETURNING "id"
		`);
		return { count: updated.length, reason: updated.length === 1 ? null : 'state' as const };
	}, client);
}

export function replaceMultipartGeneration(
	input: {
		sessionId: string;
		expectedGeneration: number;
		newUploadId: string;
		abortBucket: string;
		reason: string;
	},
	client: PrismaClient,
) {
	return withSerializableRetry(async (tx) => {
		const sessions = await tx.$queryRaw<Array<{
			id: string;
			s3Key: string;
			s3UploadId: string | null;
		}>>(Prisma.sql`
			SELECT session."id",
				session."s3_key" AS "s3Key",
				session."s3_upload_id" AS "s3UploadId"
			FROM "game_upload_sessions" AS session
			WHERE session."id" = ${input.sessionId}
				AND session."status" = 'PENDING'
				AND session."multipart_generation" = ${input.expectedGeneration}
				AND session."s3_key" IS NOT NULL
				AND NOT EXISTS (
					SELECT 1
					FROM "game_upload_part_claims" AS claim
					WHERE claim."session_id" = session."id"
						AND claim."lease_until" > clock_timestamp()
				)
			FOR UPDATE OF session
		`);
		const session = sessions[0];
		if (!session) return { replaced: false as const, durableAbort: null };
		let durableAbort: DurablyTrackedMultipartAbort | null = null;
		if (session.s3UploadId) {
			durableAbort = {
				tracking: 'durable-abort-task-committed',
				sessionId: session.id,
				key: session.s3Key,
				uploadId: session.s3UploadId,
				reason: input.reason,
			};
			await queueMultipartAbortTask(tx, {
				bucket: input.abortBucket,
				storageKey: durableAbort.key,
				uploadId: durableAbort.uploadId,
				reason: durableAbort.reason,
			});
		}
		await tx.gameUploadPart.deleteMany({ where: { sessionId: input.sessionId } });
		await tx.gameUploadPartClaim.deleteMany({ where: { sessionId: input.sessionId } });
		await tx.gameUploadSession.update({
			where: { id: input.sessionId },
			data: {
				s3UploadId: input.newUploadId,
				multipartGeneration: { increment: 1 },
				uploadedChunks: [],
			},
		});
		return { replaced: true as const, durableAbort };
	}, client);
}

export function findPartsBySessionId(sessionId: string, client: PrismaClient) {
	return client.gameUploadPart.findMany({
		where: { sessionId },
		orderBy: { partNumber: 'asc' },
	});
}

/** Revert a COMPLETING session back to PENDING (for retry on error) */
export function revertToPending(
	sessionId: string,
	client: PrismaClient,
	completionClaimToken: string,
) {
	return (async () => {
		const reverted = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
			UPDATE "game_upload_sessions"
			SET "status" = 'PENDING',
				"completion_claim_token" = NULL,
				"completion_claim_until" = NULL,
				"updated_at" = clock_timestamp()
			WHERE "id" = ${sessionId}
				AND "status" = 'COMPLETING'
				AND "completion_claim_token" = ${completionClaimToken}
				AND "completion_claim_until" > clock_timestamp()
			RETURNING "id"
		`);
		return { count: reverted.length };
	})();
}

export function markFailed(
	sessionId: string,
	storageKey: string | null | undefined,
	client: PrismaClient,
	completionClaimToken: string,
	publicBucket?: string,
	abortBucket?: string,
) {
	return withSerializableRetry(async (tx) => {
		const session = await tx.gameUploadSession.findUnique({
			where: { id: sessionId },
			select: { uploadKind: true, projectId: true, s3Key: true },
		});
		const failed = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
			UPDATE "game_upload_sessions"
			SET "status" = 'FAILED',
				"completion_claim_token" = NULL,
				"completion_claim_until" = NULL,
				"storage_key" = COALESCE(${storageKey ?? null}, "storage_key"),
				"updated_at" = clock_timestamp()
			WHERE "id" = ${sessionId}
				AND "status" = 'COMPLETING'
				AND "completion_claim_token" = ${completionClaimToken}
				AND "completion_claim_until" > clock_timestamp()
			RETURNING "id"
		`);
		const result = { count: failed.length };
		if (result.count !== 1) return result;
		if (session?.uploadKind === 'WEBGL' && session.s3Key && publicBucket && abortBucket) {
			await queueDurableDeletions(tx, webglDeletionTargetsBySource(
				session.projectId, session.s3Key,
				{ publicBucket, protectedBucket: abortBucket },
				'webgl-completing-session-failed',
			));
		}
		await tx.gameUploadActiveSession.deleteMany({
			where: { sessionId },
		});
		return result;
	}, client);
}

/**
 * Terminal validation after CompleteMultipartUpload must never delete first.
 * Commit the FAILED state, active-slot release, and object-deletion outbox in
 * one transaction so a process death at any later point remains recoverable.
 */
export function markCompletedObjectFailed(
	input: {
		sessionId: string;
		storageKey: string;
		reason: string;
		bucket: string;
		publicBucket?: string;
		completionClaimToken: string;
	},
	client: PrismaClient,
) {
	return withSerializableRetry(async (tx) => {
		if (!await lockActiveCompletionClaim(tx, input.sessionId, input.completionClaimToken)) {
			return { count: 0 };
		}
		const session = await tx.gameUploadSession.findUnique({
			where: { id: input.sessionId },
			select: { uploadKind: true, projectId: true, s3Key: true },
		});
		const result = await tx.gameUploadSession.updateMany({
			where: {
				id: input.sessionId,
				status: 'COMPLETING',
				completionClaimToken: input.completionClaimToken,
			},
			data: {
				status: 'FAILED',
				storageKey: input.storageKey,
				s3UploadId: null,
				s3Key: null,
				completionClaimToken: null,
				completionClaimUntil: null,
			},
		});
		if (result.count !== 1) return result;
		const targets = session?.uploadKind === 'WEBGL' && session.s3Key && input.publicBucket
			? webglDeletionTargetsBySource(session.projectId, session.s3Key, {
				protectedBucket: input.bucket, publicBucket: input.publicBucket,
			}, input.reason)
			: [{ bucket: input.bucket, storageKey: input.storageKey, targetKind: 'EXACT' as const, reason: input.reason }];
		await queueDurableDeletions(tx, targets);
		await tx.gameUploadActiveSession.deleteMany({
			where: { sessionId: input.sessionId },
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
		completionClaimToken: string;
	},
	outbox: GameReplacementOutboxConfig,
	client: PrismaClient,
): Promise<{ assetId: number; oldStorageKey: string | null; oldPlaybackStorageKey: string | null }> {
	return withAssetMutationTransaction(client, async (tx) => {
		if (!await lockActiveCompletionClaim(tx, sessionId, data.completionClaimToken)) {
			throw new Error('Game upload completion claim is no longer active');
		}
		await assertNoDeletionClaim(tx, {
			bucket: outbox.bucket,
			key: data.storageKey,
		});
		if (data.playbackStorageKey && data.playbackStorageKey !== data.storageKey) {
			await assertNoDeletionClaim(tx, {
				bucket: outbox.bucket,
				key: data.playbackStorageKey,
			});
		}
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
			if (existing.storageKey !== data.storageKey) {
				await tx.gameUploadSession.updateMany({
					where: {
						id: { not: sessionId },
						status: 'COMPLETED',
						storageKey: existing.storageKey,
					},
					data: { storageKey: null },
				});
			}
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
			where: {
				id: sessionId,
				status: 'COMPLETING',
				uploadKind: 'GAME',
				completionClaimToken: data.completionClaimToken,
			},
			data: {
				status: 'COMPLETED',
				storageKey: data.storageKey,
				completionClaimToken: null,
				completionClaimUntil: null,
				completionResult: {
					status: 'COMPLETED',
					storageKey: data.storageKey,
					sizeBytes: Number(data.sizeBytes),
				},
			},
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
	completionClaimToken: string,
	completionResult: { status: 'COMPLETED'; storageKey: string; sizeBytes: number; webglUrl: string } = {
		status: 'COMPLETED', storageKey: sourceKey, sizeBytes: 0, webglUrl: '',
	},
): Promise<{ oldEntryKey: string }> {
	return withSerializableRetry(async (tx) => {
		if (!await lockActiveCompletionClaim(tx, sessionId, completionClaimToken)) {
			throw new Error('WebGL upload completion claim is no longer active');
		}
		const deployment = parseWebglEntryKey(projectId, entryKey);
		if (!deployment) throw new Error('Cannot finalize malformed WebGL entry key');
		await assertNoDeletionClaim(tx, {
			bucket: outbox.protectedBucket,
			key: sourceKey,
		});
		await assertNoDeletionClaim(tx, {
			bucket: outbox.publicBucket,
			key: deployment.sitePrefix,
			targetKind: 'PREFIX',
		});
		const project = await tx.project.findUniqueOrThrow({
			where: { id: projectId },
			select: { webglEntryKey: true },
		});
		const oldDeployment = project.webglEntryKey === entryKey
			? null
			: parseWebglEntryKey(projectId, project.webglEntryKey);
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
		if (oldDeployment?.sourceKey && oldDeployment.sourceKey !== sourceKey) {
			await tx.gameUploadSession.updateMany({
				where: {
					id: { not: sessionId },
					status: 'COMPLETED',
					storageKey: oldDeployment.sourceKey,
				},
				data: { storageKey: null },
			});
		}
		const completed = await tx.gameUploadSession.updateMany({
			where: {
				id: sessionId,
				status: 'COMPLETING',
				uploadKind: 'WEBGL',
				completionClaimToken,
			},
			data: {
				status: 'COMPLETED',
				storageKey: sourceKey,
				completionClaimToken: null,
				completionClaimUntil: null,
				completionResult,
			},
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

export function claimStaleCompletingSessions(
	cutoff: Date,
	token: string,
	leaseMs: number,
	limit: number,
	client: PrismaClient,
) {
	return withSerializableRetry(async (tx) => {
		const candidates = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
			WITH candidates AS (
				SELECT session."id"
				FROM "game_upload_sessions" AS session
				WHERE session."status" = 'COMPLETING'
					AND (
						(session."completion_claim_until" IS NULL AND session."updated_at" < ${cutoff})
						OR session."completion_claim_until" <= clock_timestamp()
					)
				ORDER BY session."updated_at" ASC
				LIMIT ${limit}
				FOR UPDATE OF session SKIP LOCKED
			)
			UPDATE "game_upload_sessions" AS session
			SET "completion_claim_token" = ${token},
				"completion_claim_until" = clock_timestamp()
					+ (${leaseMs} * INTERVAL '1 millisecond'),
				"updated_at" = clock_timestamp()
			FROM candidates
			WHERE session."id" = candidates."id"
			RETURNING session."id"
		`);
		if (candidates.length === 0) return [];
		return tx.gameUploadSession.findMany({
			where: { id: { in: candidates.map(({ id }) => id) }, completionClaimToken: token },
		});
	}, client);
}

/** Find an exhibition by ID */
export function findExhibitionById(id: number, client: PrismaClient) {
	return client.exhibition.findUnique({ where: { id } });
}

/**
 * Bind every game-upload query and transaction to one context-owned Prisma
 * client. No query helper reaches a process-global client.
 */
export function createGameUploadRepository(
	client: PrismaClient,
	options: GameUploadRepositoryOptions,
): DurableGameUploadRepository {
	return {
		findSessionById: (id: string) => findSessionById(id, client),
		createSessionReplacingActive: (data: CreateSessionData) => (
			createSessionReplacingActive(
				data,
				client,
				options.abortBucket,
				options.publicBucket,
			)
		),
		cancelSessionAndClearActive: (id: string) => cancelSessionAndClearActive(
			id,
			client,
			options.abortBucket,
		),
		queueAbortTask: (target: { key: string; uploadId: string; reason: string }) => (
			client.$transaction((tx) => queueMultipartAbortTask(tx, {
				bucket: options.abortBucket,
				storageKey: target.key,
				uploadId: target.uploadId,
				reason: target.reason,
			}))
		),
		acquirePartClaim: (input: Parameters<typeof acquirePartClaim>[0]) => acquirePartClaim(input, client),
		completePartClaim: (input: Parameters<typeof completePartClaim>[0]) => completePartClaim(input, client),
		renewPartClaim: async (token: string, leaseMs: number) => {
			const renewed = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				UPDATE "game_upload_part_claims"
				SET "lease_until" = clock_timestamp()
						+ (${leaseMs} * INTERVAL '1 millisecond'),
					"updated_at" = clock_timestamp()
				WHERE "token" = ${token}
					AND "lease_until" > clock_timestamp()
				RETURNING "id"
			`);
			return { count: renewed.length };
		},
		claimCompletion: (input: Parameters<typeof claimCompletion>[0]) => claimCompletion(input, client),
		renewCompletionClaim: async (sessionId: string, token: string, leaseMs: number) => {
			const renewed = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				UPDATE "game_upload_sessions"
				SET "completion_claim_until" = clock_timestamp()
						+ (${leaseMs} * INTERVAL '1 millisecond'),
					"updated_at" = clock_timestamp()
				WHERE "id" = ${sessionId}
					AND "status" = 'COMPLETING'
					AND "completion_claim_token" = ${token}
					AND "completion_claim_until" > clock_timestamp()
				RETURNING "id"
			`);
			return { count: renewed.length };
		},
		releaseCompletionClaim: async (sessionId: string, token: string, reason: string) => {
			const released = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				UPDATE "game_upload_sessions"
				SET "completion_claim_token" = NULL,
					"completion_claim_until" = clock_timestamp(),
					"completion_last_error" = ${reason.slice(0, 500)},
					"updated_at" = clock_timestamp()
				WHERE "id" = ${sessionId}
					AND "status" = 'COMPLETING'
					AND "completion_claim_token" = ${token}
					AND "completion_claim_until" > clock_timestamp()
				RETURNING "id"
			`);
			return { count: released.length };
		},
		replaceMultipartGeneration: (input: Omit<Parameters<typeof replaceMultipartGeneration>[0], 'abortBucket'>) => (
			replaceMultipartGeneration({
				...input,
				abortBucket: options.abortBucket,
			}, client)
		),
		findPartsBySessionId: (sessionId: string) => findPartsBySessionId(sessionId, client),
		revertToPending: (sessionId: string, completionClaimToken: string) => (
			revertToPending(sessionId, client, completionClaimToken)
		),
		markFailed: (
			sessionId: string,
			storageKey: string | null | undefined,
			completionClaimToken: string,
		) => (
			markFailed(
				sessionId, storageKey, client, completionClaimToken,
				options.publicBucket, options.abortBucket,
			)
		),
		markCompletedObjectFailed: (input: {
			sessionId: string;
			storageKey: string;
			reason: string;
			completionClaimToken: string;
		}) => markCompletedObjectFailed({
			...input,
			bucket: options.abortBucket,
			publicBucket: options.publicBucket,
		}, client),
		claimStaleCompletingSessions: (
			cutoff: Date,
			token: string,
			leaseMs: number,
			limit: number,
		) => claimStaleCompletingSessions(cutoff, token, leaseMs, limit, client),
		findExpiredPendingSessions: (now: Date, limit: number) => client.gameUploadSession.findMany({
			where: { status: 'PENDING', expiresAt: { lte: now } },
			orderBy: { expiresAt: 'asc' },
			take: limit,
		}),
		findSessionsWithExpiredPartClaims: async (limit: number) => {
			const expired = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				SELECT session."id"
				FROM "game_upload_sessions" AS session
				WHERE session."status" = 'PENDING'
					AND EXISTS (
						SELECT 1
						FROM "game_upload_part_claims" AS claim
						WHERE claim."session_id" = session."id"
							AND claim."lease_until" <= clock_timestamp()
					)
				ORDER BY session."updated_at" ASC
				LIMIT ${limit}
			`);
			if (expired.length === 0) return [];
			return client.gameUploadSession.findMany({
				where: { id: { in: expired.map(({ id }) => id) } },
				include: { parts: { orderBy: { partNumber: 'asc' } } },
				orderBy: { updatedAt: 'asc' },
			});
		},
		findKnownMultipartUploads: () => client.gameUploadSession.findMany({
			where: { s3UploadId: { not: null }, s3Key: { not: null } },
			select: { s3Key: true, s3UploadId: true },
		}),
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
				completionClaimToken: string;
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
			completionClaimToken: string,
			completionResult?: { status: 'COMPLETED'; storageKey: string; sizeBytes: number; webglUrl: string },
		) => finalizeCompletedWebglSession(
			sessionId,
			projectId,
			entryKey,
			sourceKey,
			outbox,
			client,
			completionClaimToken,
			completionResult,
		),
	};
}

/** The complete production persistence contract, including durability/fencing methods. */
export interface DurableGameUploadRepository extends GameUploadRepository {
	finalizeCompletedSession(
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
			completionClaimToken: string;
		},
		outbox: GameReplacementOutboxConfig,
	): Promise<{
		assetId: number;
		oldStorageKey: string | null;
		oldPlaybackStorageKey: string | null;
	}>;
	finalizeCompletedWebglSession(
		sessionId: string,
		projectId: number,
		entryKey: string,
		sourceKey: string,
		outbox: WebglReplacementOutboxConfig,
		completionClaimToken: string,
		completionResult?: {
			status: 'COMPLETED';
			storageKey: string;
			sizeBytes: number;
			webglUrl: string;
		},
	): Promise<{ oldEntryKey: string }>;
}
