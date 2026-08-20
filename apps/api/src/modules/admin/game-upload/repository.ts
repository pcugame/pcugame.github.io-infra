import {
	Prisma,
	type AssetKind,
	type AssetPlaybackStatus,
	type PrismaClient,
	type UploadKind,
} from '../../../generated/prisma/client.js';
import type { UserRole } from '@pcu/contracts';
import {
	ActiveUploadCompletionInProgressError,
	DirectUploadQuotaExceededError,
	GameUploadTargetFencedError,
	type DurablyTrackedMultipartAbort,
	type DirectUploadQuotaLimits,
	type GameUploadRepository,
	type GameUploadSessionSummary,
	type NewGameUploadSession,
} from './ports.js';
import { queueDurableDeletions } from '../../orphan/outbox.js';
import {
	webglDeletionTargetsByEntry,
	webglDeletionTargetsBySource,
	webglPublicDeletionTarget,
	webglSourceDeletionTarget,
} from '../../webgl/deletion-targets.js';
import {
	createWebglPublicDeploymentKeys,
	parseWebglEntryKey,
	parseWebglSourceKey,
} from '../../webgl/paths.js';
import {
	ASSET_MUTATION_TRANSACTION_POLICY,
	withAssetMutationTransaction,
} from '../../assets/mutation-transaction.js';
import { queueMultipartAbortTask } from '../../multipart-abort/repository.js';
import { assertNoDeletionClaim } from '../../orphan/reference-resolver.js';
import { assertWriteAccess } from '../project-access.service.js';
import { assertUploadAllowed } from '../upload-guard.js';
import { badRequest, conflict, forbidden, notFound } from '../../../shared/errors.js';

type TxClient = Prisma.TransactionClient;

async function lockProjectForUploadMutation(
	tx: TxClient,
	projectId: number,
): Promise<void> {
	const projects = await tx.$queryRaw<Array<{ id: number }>>(Prisma.sql`
		SELECT "id"
		FROM "projects"
		WHERE "id" = ${projectId}
		FOR UPDATE
	`);
	if (projects.length === 0) throw new Error('Project no longer exists');
}

async function lockActorForUploadMutation(
	tx: TxClient,
	actorId: number,
): Promise<{ id: number; role: string }> {
	const actors = await tx.$queryRaw<Array<{ id: number; role: string }>>(Prisma.sql`
		SELECT "id", "role"::text AS "role"
		FROM "users"
		WHERE "id" = ${actorId}
		FOR UPDATE
	`);
	const actor = actors[0];
	if (!actor) throw notFound('Upload actor no longer exists');
	return actor;
}

async function activeQuotaUsage(
	tx: TxClient,
	input: { actorId: number; projectId: number; excludeSessionId?: string },
): Promise<{ actorActive: number; projectActive: number; actorBytes: bigint }> {
	const exclusion = input.excludeSessionId
		? Prisma.sql`AND session."id" <> ${input.excludeSessionId}`
		: Prisma.empty;
	const [usage] = await tx.$queryRaw<Array<{
		actorActive: number;
		projectActive: number;
		actorBytes: bigint;
	}>>(Prisma.sql`
		SELECT
			COUNT(*) FILTER (WHERE session."user_id" = ${input.actorId})::integer
				AS "actorActive",
			COUNT(*) FILTER (WHERE session."project_id" = ${input.projectId})::integer
				AS "projectActive",
			COALESCE(SUM(session."total_bytes") FILTER (
				WHERE session."user_id" = ${input.actorId}
			), 0)::bigint AS "actorBytes"
		FROM "game_upload_active_sessions" AS slot
		JOIN "game_upload_sessions" AS session ON session."id" = slot."session_id"
		WHERE session."status" IN ('PENDING', 'COMPLETING', 'VERIFYING')
		${exclusion}
	`);
	return usage ?? { actorActive: 0, projectActive: 0, actorBytes: 0n };
}

async function assertProjectedQuota(
	tx: TxClient,
	input: {
		actorId: number;
		projectId: number;
		totalBytes: bigint;
		limits: DirectUploadQuotaLimits;
		excludeSessionId?: string;
	},
): Promise<void> {
	const usage = await activeQuotaUsage(tx, input);
	if (usage.actorActive + 1 > input.limits.actorActiveSessions) {
		throw new DirectUploadQuotaExceededError('ACTOR_ACTIVE_SESSIONS');
	}
	if (usage.projectActive + 1 > input.limits.projectActiveSessions) {
		throw new DirectUploadQuotaExceededError('PROJECT_ACTIVE_SESSIONS');
	}
	if (usage.actorBytes + input.totalBytes > input.limits.actorOutstandingBytes) {
		throw new DirectUploadQuotaExceededError('ACTOR_OUTSTANDING_BYTES');
	}
}

async function assertCurrentCreatePolicy(
	tx: TxClient,
	input: { actorId: number; actorRole: UserRole; projectId: number },
): Promise<void> {
	const [policy] = await tx.$queryRaw<Array<{
		creatorId: number;
		exhibitionId: number;
		exhibitionYear: number;
		exhibitionTitle: string;
		isUploadEnabled: boolean;
	}>>(Prisma.sql`
		SELECT project."creator_id" AS "creatorId",
			exhibition."id" AS "exhibitionId",
			exhibition."year" AS "exhibitionYear",
			exhibition."title" AS "exhibitionTitle",
			exhibition."is_upload_enabled" AS "isUploadEnabled"
		FROM "projects" AS project
		JOIN "exhibitions" AS exhibition ON exhibition."id" = project."exhibition_id"
		WHERE project."id" = ${input.projectId}
		FOR SHARE OF exhibition
	`);
	if (!policy) throw notFound('Upload project no longer exists');
	const isPrivileged = input.actorRole === 'ADMIN' || input.actorRole === 'OPERATOR';
	const memberships = isPrivileged ? [{ id: 0 }] : await tx.$queryRaw<Array<{ id: number }>>(Prisma.sql`
		SELECT "id"
		FROM "project_members"
		WHERE "project_id" = ${input.projectId}
			AND "user_id" = ${input.actorId}
		FOR SHARE
	`);
	assertWriteAccess(input.actorRole, policy.creatorId, input.actorId, {
		isMember: memberships.length > 0,
	});
	assertUploadAllowed({
		id: policy.exhibitionId,
		year: policy.exhibitionYear,
		title: policy.exhibitionTitle,
		isUploadEnabled: policy.isUploadEnabled,
	}, policy.exhibitionId, input.actorRole);
}

async function lockExhibitionForProjectFinalization(
	tx: TxClient,
	projectId: number,
): Promise<void> {
	const exhibitions = await tx.$queryRaw<Array<{ id: number }>>(Prisma.sql`
		SELECT exhibition."id"
		FROM "exhibitions" AS exhibition
		JOIN "projects" AS project ON project."exhibition_id" = exhibition."id"
		WHERE project."id" = ${projectId}
		FOR SHARE OF exhibition
	`);
	if (exhibitions.length === 0) throw new Error('Upload exhibition no longer exists');
}

async function lockActiveCompletionClaim(
	tx: TxClient,
	sessionId: string,
	token: string,
): Promise<boolean> {
	const active = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
		SELECT "id"
		FROM "game_upload_sessions"
		WHERE "id" = ${sessionId}
			AND "status" IN ('COMPLETING', 'VERIFYING')
			AND "completion_claim_token" = ${token}
			AND "completion_claim_until" > clock_timestamp()
		FOR UPDATE
	`);
	return active.length === 1;
}

/**
 * Re-evaluate the session actor's current role, membership, and exhibition
 * policy inside the final pointer/Asset transaction. Serializable isolation
 * makes concurrent membership or upload-policy changes conflict with commit.
 */
async function assertCurrentFinalizationPolicy(
	tx: TxClient,
	sessionId: string,
	projectId: number,
): Promise<void> {
	const rows = await tx.$queryRaw<Array<{
		userId: number;
		role: string;
		creatorId: number;
		exhibitionId: number;
		exhibitionYear: number;
		exhibitionTitle: string;
		isUploadEnabled: boolean;
	}>>(Prisma.sql`
		SELECT
			session."user_id" AS "userId",
			actor."role"::text AS "role",
			project."creator_id" AS "creatorId",
			exhibition."id" AS "exhibitionId",
			exhibition."year" AS "exhibitionYear",
			exhibition."title" AS "exhibitionTitle",
			exhibition."is_upload_enabled" AS "isUploadEnabled"
		FROM "game_upload_sessions" AS session
		JOIN "users" AS actor ON actor."id" = session."user_id"
		JOIN "projects" AS project ON project."id" = session."project_id"
		JOIN "exhibitions" AS exhibition ON exhibition."id" = project."exhibition_id"
		WHERE session."id" = ${sessionId}
			AND session."project_id" = ${projectId}
		FOR SHARE OF actor
	`);
	const current = rows[0];
	if (!current) throw new Error('Upload finalization subject no longer exists');
	const memberships = await tx.$queryRaw<Array<{ id: number }>>(Prisma.sql`
		SELECT "id"
		FROM "project_members"
		WHERE "project_id" = ${projectId}
			AND "user_id" = ${current.userId}
		FOR SHARE
	`);
	const role = current.role as UserRole;
	assertWriteAccess(role, current.creatorId, current.userId, {
		isMember: memberships.length > 0,
	});
	assertUploadAllowed({
		id: current.exhibitionId,
		year: current.exhibitionYear,
		title: current.exhibitionTitle,
		isUploadEnabled: current.isUploadEnabled,
	}, current.exhibitionId, role);
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

const sessionWithProject = {
	include: {
		project: { select: { status: true } },
		activeSlot: { select: { sessionId: true } },
	},
} satisfies Prisma.GameUploadSessionDefaultArgs;

export type UploadSessionRecord = Prisma.GameUploadSessionGetPayload<
	typeof sessionWithProject
>;

export type UploadSessionSummaryRecord = Prisma.GameUploadSessionGetPayload<Record<string, never>>;

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
		...sessionWithProject,
	});
}

type CreateSessionData = NewGameUploadSession;

interface GameUploadRepositoryOptions {
	abortBucket: string;
	publicBucket?: string;
}

/** Fast, side-effect-free quota preflight before allocating a storage upload ID. */
export function assertCanCreateSession(
	input: {
		projectId: number;
		userId: number;
		uploadKind: UploadKind;
		totalBytes: bigint;
		limits: DirectUploadQuotaLimits;
	},
	client: PrismaClient,
): Promise<void> {
	return withSerializableRetry(async (tx) => {
		// Use the same stable lock order as final creation. The second quota check
		// in createSessionReplacingActive closes the storage-allocation race.
		await lockProjectForUploadMutation(tx, input.projectId);
		const actor = await lockActorForUploadMutation(tx, input.userId);
		await assertCurrentCreatePolicy(tx, {
			actorId: actor.id,
			actorRole: actor.role as UserRole,
			projectId: input.projectId,
		});
		const active = await tx.gameUploadActiveSession.findUnique({
			where: {
				projectId_uploadKind: {
					projectId: input.projectId,
					uploadKind: input.uploadKind,
				},
			},
			include: { session: true },
		});
		if (active?.session.status === 'COMPLETING' || active?.session.status === 'VERIFYING') {
			throw new ActiveUploadCompletionInProgressError();
		}
		await assertProjectedQuota(tx, {
			actorId: input.userId,
			projectId: input.projectId,
			totalBytes: input.totalBytes,
			limits: input.limits,
			...(active ? { excludeSessionId: active.sessionId } : {}),
		});
	}, client);
}

/**
 * Atomically reserve one capability batch after re-checking every mutable
 * authority and quota. The returned upload locator is the transaction's
 * snapshot; no raw upload ID is ever persisted outside the session itself.
 */
export function reservePartCapabilities(
	input: {
		sessionId: string;
		actor: { id: number; role: UserRole };
		generation: number;
		partNumbers: number[];
		maxIssuesPerWindow: number;
		issueWindowMs: number;
		quota: DirectUploadQuotaLimits;
	},
	client: PrismaClient,
): Promise<{ session: UploadSessionRecord; isRefresh: boolean }> {
	return withSerializableRetry(async (tx) => {
		const locator = await tx.gameUploadSession.findUnique({
			where: { id: input.sessionId },
			select: { projectId: true },
		});
		if (!locator) throw notFound('Upload session not found');
		await lockProjectForUploadMutation(tx, locator.projectId);
		const currentActor = await lockActorForUploadMutation(tx, input.actor.id);
		const session = await tx.gameUploadSession.findUnique({
			where: { id: input.sessionId },
			...sessionWithProject,
		});
		if (!session) throw notFound('Upload session not found');
		const currentRole = currentActor.role as UserRole;
		const isPrivileged = currentRole === 'ADMIN' || currentRole === 'OPERATOR';
		if (!isPrivileged && session.userId !== input.actor.id) {
			throw forbidden('Not your upload session');
		}

		const [policy] = await tx.$queryRaw<Array<{
			creatorId: number;
			exhibitionId: number;
			exhibitionYear: number;
			exhibitionTitle: string;
			isUploadEnabled: boolean;
		}>>(Prisma.sql`
			SELECT project."creator_id" AS "creatorId",
				exhibition."id" AS "exhibitionId",
				exhibition."year" AS "exhibitionYear",
				exhibition."title" AS "exhibitionTitle",
				exhibition."is_upload_enabled" AS "isUploadEnabled"
			FROM "projects" AS project
			JOIN "exhibitions" AS exhibition
				ON exhibition."id" = project."exhibition_id"
			WHERE project."id" = ${session.projectId}
			FOR SHARE OF exhibition
		`);
		if (!policy) throw notFound('Upload project no longer exists');
		const memberships = isPrivileged ? [{ id: 0 }] : await tx.$queryRaw<Array<{ id: number }>>(Prisma.sql`
			SELECT "id"
			FROM "project_members"
			WHERE "project_id" = ${session.projectId}
				AND "user_id" = ${input.actor.id}
			FOR SHARE
		`);
		assertWriteAccess(currentRole, policy.creatorId, input.actor.id, {
			isMember: memberships.length > 0,
		});
		assertUploadAllowed({
			id: policy.exhibitionId,
			year: policy.exhibitionYear,
			title: policy.exhibitionTitle,
			isUploadEnabled: policy.isUploadEnabled,
		}, policy.exhibitionId, currentRole);

		if (session.status !== 'PENDING') {
			throw badRequest(`Cannot issue part URLs: session is ${session.status}`);
		}
		if (session.multipartGeneration !== input.generation) {
			throw conflict('Upload generation is stale');
		}
		if (session.activeSlot?.sessionId !== session.id) {
			throw conflict('Upload session has been replaced');
		}
		const [databaseTime] = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
			SELECT clock_timestamp() AS "now"
		`);
		if (!databaseTime || session.expiresAt <= databaseTime.now) {
			throw badRequest('Upload session has expired');
		}
		if (!session.s3Key || !session.s3UploadId) {
			throw new Error('Session is missing S3 multipart info');
		}
		for (const partNumber of input.partNumbers) {
			if (!Number.isSafeInteger(partNumber)
				|| partNumber < 1
				|| partNumber > session.totalChunks) {
				throw badRequest(`Part number must be between 1 and ${session.totalChunks}`);
			}
		}
		await assertProjectedQuota(tx, {
			actorId: session.userId,
			projectId: session.projectId,
			totalBytes: session.totalBytes,
			limits: input.quota,
			excludeSessionId: session.id,
		});

		const [issueState] = await tx.$queryRaw<Array<{ lastIssuedAt: Date | null }>>(Prisma.sql`
			SELECT "part_url_last_issued_at" AS "lastIssuedAt"
			FROM "game_upload_sessions"
			WHERE "id" = ${session.id}
			FOR UPDATE
		`);
		const isRefresh = issueState?.lastIssuedAt !== null;
		const reserved = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
			UPDATE "game_upload_sessions"
			SET "part_url_issue_window_count" = CASE
					WHEN "part_url_issue_window_started_at" IS NULL
						OR "part_url_issue_window_started_at" <= clock_timestamp()
							- (${input.issueWindowMs} * INTERVAL '1 millisecond')
					THEN 1
					ELSE "part_url_issue_window_count" + 1
				END,
				"part_url_issue_window_started_at" = CASE
					WHEN "part_url_issue_window_started_at" IS NULL
						OR "part_url_issue_window_started_at" <= clock_timestamp()
							- (${input.issueWindowMs} * INTERVAL '1 millisecond')
					THEN clock_timestamp()
					ELSE "part_url_issue_window_started_at"
				END,
				"part_url_last_issued_at" = clock_timestamp(),
				"updated_at" = clock_timestamp()
			WHERE "id" = ${session.id}
				AND "status" = 'PENDING'
				AND "multipart_generation" = ${input.generation}
				AND "expires_at" > clock_timestamp()
				AND (
					"part_url_issue_window_started_at" IS NULL
					OR "part_url_issue_window_started_at" <= clock_timestamp()
						- (${input.issueWindowMs} * INTERVAL '1 millisecond')
					OR "part_url_issue_window_count" < ${input.maxIssuesPerWindow}
				)
			RETURNING "id"
		`);
		if (reserved.length !== 1) {
			throw new DirectUploadQuotaExceededError('PART_URL_REFRESH');
		}
		return { session, isRefresh };
	}, client);
}

/** Create a new session and replace the project's active slot atomically. */
export function createSessionReplacingActive(
	data: CreateSessionData,
	limits: DirectUploadQuotaLimits,
	client: PrismaClient,
	abortBucket: string,
	publicBucket?: string,
) {
	return withSerializableRetry(async (tx) => {
		await lockProjectForUploadMutation(tx, data.projectId);
		const actor = await lockActorForUploadMutation(tx, data.userId);
		await assertCurrentCreatePolicy(tx, {
			actorId: actor.id,
			actorRole: actor.role as UserRole,
			projectId: data.projectId,
		});
		await assertNoDeletionClaim(tx, { bucket: abortBucket, key: data.s3Key });
		if (data.uploadKind === 'WEBGL' && !parseWebglSourceKey(data.projectId, data.s3Key)) {
			throw new Error(`Malformed WebGL source key for project ${data.projectId}`);
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
		const expectedTargetRows = data.uploadKind === 'GAME'
			? await tx.$queryRaw<Array<{ id: number; updatedAt: Date }>>(Prisma.sql`
				SELECT "id", "updated_at" AS "updatedAt"
				FROM "assets"
				WHERE "project_id" = ${data.projectId}
					AND "kind" = 'GAME'::"AssetKind"
					AND "status" = 'READY'::"AssetStatus"
				ORDER BY "id"
				LIMIT 1
				FOR UPDATE
			`)
			: [];
		const expectedTarget = expectedTargetRows[0] ?? null;

		// A completing upload may already have committed its multipart object. It
		// must retain the active slot until finalization/recovery reaches a terminal
		// state; cancelling it here would strand that object outside recovery.
		if (active?.session.status === 'COMPLETING' || active?.session.status === 'VERIFYING') {
			throw new ActiveUploadCompletionInProgressError();
		}
		await assertProjectedQuota(tx, {
			actorId: data.userId,
			projectId: data.projectId,
			totalBytes: data.totalBytes,
			limits,
			...(active ? { excludeSessionId: active.sessionId } : {}),
		});

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

		const session = await tx.gameUploadSession.create({
			data: {
				...data,
				sourceIdentityBlockManifest: Buffer.from(data.sourceIdentityBlockManifest),
				expectedTargetAssetId: expectedTarget?.id ?? null,
				expectedTargetAssetUpdatedAt: expectedTarget?.updatedAt ?? null,
			},
		});
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
	terminalStatus: 'CANCELLED' | 'EXPIRED' = 'CANCELLED',
) {
	return withSerializableRetry(async (tx) => {
		const session = await tx.gameUploadSession.findUnique({
			where: { id },
			select: { s3Key: true, s3UploadId: true },
		});
		const result = await tx.gameUploadSession.updateMany({
			where: { id, status: 'PENDING' },
			data: { status: terminalStatus, s3UploadId: null, s3Key: null },
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

/** Find all active upload/finalization sessions for a project. */
export function findActiveSessions(projectId: number, client: PrismaClient) {
	return client.gameUploadSession.findMany({
		where: {
			projectId,
			status: { in: ['PENDING', 'COMPLETING', 'VERIFYING'] },
		},
	});
}

/** Find active sessions for a project, optionally filtered by user */
export function findActiveSessionsForListing(
	projectId: number,
	opts: { userId?: number },
	client: PrismaClient,
): Promise<UploadSessionSummaryRecord[]> {
	return client.gameUploadSession.findMany({
		where: {
			projectId,
			status: { in: ['PENDING', 'COMPLETING', 'VERIFYING'] },
			...(opts.userId ? { userId: opts.userId } : {}),
		},
		orderBy: { createdAt: 'desc' },
	});
}

export function claimCompletion(
	input: { sessionId: string; generation: number; token: string; leaseMs: number },
	client: PrismaClient,
) {
	return withSerializableRetry(async (tx) => {
		const locator = await tx.gameUploadSession.findUnique({
			where: { id: input.sessionId },
			select: { projectId: true },
		});
		if (!locator) return { count: 0, reason: 'state' as const };
		await lockProjectForUploadMutation(tx, locator.projectId);
		const session = await tx.gameUploadSession.findUnique({
			where: { id: input.sessionId },
			include: { activeSlot: true },
		});
		if (!session || session.status !== 'PENDING'
			|| session.multipartGeneration !== input.generation
			|| session.activeSlot?.sessionId !== session.id) {
			return { count: 0, reason: 'state' as const };
		}
		const [databaseTime] = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
			SELECT clock_timestamp() AS "now"
		`);
		if (!databaseTime || session.expiresAt <= databaseTime.now) {
			return { count: 0, reason: 'state' as const };
		}
		const sourceIdentityMissing = session.sourceIdentityAlgorithm !== 'SHA256_BLOCK_MANIFEST_V1'
			|| !session.sourceIdentity
			|| session.sourceIdentityBlockSizeBytes !== 1048576
			|| !session.sourceIdentityBlockManifest;
		if (sourceIdentityMissing) {
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
				AND "expires_at" > clock_timestamp()
			RETURNING "id"
		`);
		return { count: updated.length, reason: updated.length === 1 ? null : 'state' as const };
	}, client);
}

/** Commit storage completion before any validation or Asset mutation occurs. */
export function markVerifying(
	input: {
		sessionId: string;
		generation: number;
		storageKey: string;
		verifiedSizeBytes: number;
		completionClaimToken: string;
	},
	client: PrismaClient,
) {
	return (async () => {
		const updated = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
			UPDATE "game_upload_sessions"
			SET "status" = 'VERIFYING',
				"storage_key" = ${input.storageKey},
				"s3_upload_id" = NULL,
				"completion_claim_token" = NULL,
				"completion_claim_until" = NULL,
				"completion_last_error" = NULL,
				"completion_result" = ${JSON.stringify({
					status: 'VERIFYING',
					sessionId: input.sessionId,
					generation: input.generation,
					sizeBytes: input.verifiedSizeBytes,
				})}::jsonb,
				"updated_at" = clock_timestamp()
			WHERE "id" = ${input.sessionId}
				AND "status" = 'COMPLETING'
				AND "multipart_generation" = ${input.generation}
				AND "completion_claim_token" = ${input.completionClaimToken}
				AND "completion_claim_until" > clock_timestamp()
			RETURNING "id"
		`);
		return { count: updated.length };
	})();
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
			select: {
				uploadKind: true,
				projectId: true,
				s3Key: true,
				webglDeploymentId: true,
			},
		});
		const result = await tx.gameUploadSession.updateMany({
			where: {
				id: input.sessionId,
				status: { in: ['COMPLETING', 'VERIFYING'] },
				completionClaimToken: input.completionClaimToken,
			},
			data: {
				status: 'REJECTED',
				storageKey: input.storageKey,
				s3UploadId: null,
				s3Key: null,
				completionClaimToken: null,
				completionClaimUntil: null,
			},
		});
		if (result.count !== 1) return result;
		const source = session?.uploadKind === 'WEBGL' && session.s3Key
			? parseWebglSourceKey(session.projectId, session.s3Key)
			: null;
		const targets = source
			? [
				webglSourceDeletionTarget(source, input.bucket, input.reason),
				...(input.publicBucket && session?.webglDeploymentId
					? [webglPublicDeletionTarget(
						createWebglPublicDeploymentKeys(session.projectId, session.webglDeploymentId),
						input.publicBucket,
						input.reason,
					)]
					: []),
			]
			: [{ bucket: input.bucket, storageKey: input.storageKey, targetKind: 'EXACT' as const, reason: input.reason }];
		await queueDurableDeletions(tx, targets);
		await tx.gameUploadActiveSession.deleteMany({
			where: { sessionId: input.sessionId },
		});
		return result;
	}, client);
}

/**
 * Persist the worker-only public generation before its first PUT. COALESCE and
 * the active PostgreSQL claim fence make retries/restarts converge on exactly
 * one prefix without exposing it through an API response.
 */
export function reserveWebglDeployment(
	input: {
		sessionId: string;
		completionClaimToken: string;
		candidateDeploymentId: string;
		publicBucket: string;
	},
	client: PrismaClient,
): Promise<string> {
	return withSerializableRetry(async (tx) => {
		const session = await tx.gameUploadSession.findUnique({
			where: { id: input.sessionId },
			select: {
				projectId: true,
				uploadKind: true,
				status: true,
				completionClaimToken: true,
				completionClaimUntil: true,
				webglDeploymentId: true,
			},
		});
		if (!session || session.uploadKind !== 'WEBGL' || session.status !== 'VERIFYING'
			|| session.completionClaimToken !== input.completionClaimToken) {
			throw new Error('WebGL deployment reservation claim is no longer active');
		}
		const deploymentId = session.webglDeploymentId ?? input.candidateDeploymentId;
		const keys = createWebglPublicDeploymentKeys(session.projectId, deploymentId);
		if (!parseWebglEntryKey(session.projectId, keys.entryKey)) {
			throw new Error('WebGL deployment ID generator returned an unsafe value');
		}
		await assertNoDeletionClaim(tx, {
			bucket: input.publicBucket,
			key: keys.sitePrefix,
			targetKind: 'PREFIX',
		});
		const reserved = await tx.$queryRaw<Array<{ webglDeploymentId: string }>>(Prisma.sql`
			UPDATE "game_upload_sessions"
			SET "webgl_deployment_id" = COALESCE("webgl_deployment_id", ${deploymentId}),
				"updated_at" = clock_timestamp()
			WHERE "id" = ${input.sessionId}
				AND "upload_kind" = 'WEBGL'::"UploadKind"
				AND "status" = 'VERIFYING'
				AND "completion_claim_token" = ${input.completionClaimToken}
				AND "completion_claim_until" > clock_timestamp()
			RETURNING "webgl_deployment_id" AS "webglDeploymentId"
		`);
		if (!reserved[0]) throw new Error('WebGL deployment reservation claim was lost');
		return reserved[0].webglDeploymentId;
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
		await lockExhibitionForProjectFinalization(tx, projectId);
		await lockProjectForUploadMutation(tx, projectId);
		if (!await lockActiveCompletionClaim(tx, sessionId, data.completionClaimToken)) {
			throw new Error('Game upload completion claim is no longer active');
		}
		const uploadSession = await tx.gameUploadSession.findUniqueOrThrow({
			where: { id: sessionId },
			select: {
				multipartGeneration: true,
				expectedTargetAssetId: true,
				expectedTargetAssetUpdatedAt: true,
			},
		});
		await assertCurrentFinalizationPolicy(tx, sessionId, projectId);
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
		const existingRows = await tx.$queryRaw<Array<{
			id: number;
			storageKey: string;
			playbackStorageKey: string | null;
			updatedAt: Date;
		}>>(Prisma.sql`
			SELECT
				"id",
				"storage_key" AS "storageKey",
				"playback_storage_key" AS "playbackStorageKey",
				"updated_at" AS "updatedAt"
			FROM "assets"
			WHERE "project_id" = ${projectId}
				AND "kind" = CAST(${kind} AS "AssetKind")
				AND "status" = 'READY'
			ORDER BY "id"
			LIMIT 1
			FOR UPDATE
		`);
		const existing = existingRows[0] ?? null;
		const expectedMatches = existing
			? uploadSession.expectedTargetAssetId === existing.id
				&& uploadSession.expectedTargetAssetUpdatedAt?.getTime() === existing.updatedAt.getTime()
			: uploadSession.expectedTargetAssetId === null
				&& uploadSession.expectedTargetAssetUpdatedAt === null;
		if (!expectedMatches) {
			await queueDurableDeletions(tx, [
				{
					bucket: outbox.bucket,
					storageKey: data.storageKey,
					reason: 'game-upload-stale-target-fenced',
				},
				...(data.playbackStorageKey && data.playbackStorageKey !== data.storageKey
					? [{
						bucket: outbox.bucket,
						storageKey: data.playbackStorageKey,
						reason: 'game-upload-stale-target-playback-fenced',
					}]
					: []),
			]);
			const fenced = await tx.gameUploadSession.updateMany({
				where: {
					id: sessionId,
					status: { in: ['COMPLETING', 'VERIFYING'] },
					uploadKind: 'GAME',
					completionClaimToken: data.completionClaimToken,
				},
				data: {
					status: 'REJECTED',
					storageKey: data.storageKey,
					s3Key: null,
					s3UploadId: null,
					completionClaimToken: null,
					completionClaimUntil: null,
					completionLastError: 'STALE_TARGET_ASSET',
				},
			});
			if (fenced.count !== 1) {
				throw new Error('Game upload session is no longer completing');
			}
			await tx.gameUploadActiveSession.deleteMany({ where: { sessionId } });
			return { fenced: true as const };
		}

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
				status: { in: ['COMPLETING', 'VERIFYING'] },
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
					sessionId,
					generation: uploadSession.multipartGeneration,
					sizeBytes: Number(data.sizeBytes),
					uploadKind: 'GAME',
					assetId: result.assetId,
				},
			},
		});
		if (completed.count !== 1) {
			throw new Error('Game upload session is no longer completing');
		}
		await tx.gameUploadActiveSession.deleteMany({
			where: { sessionId },
		});

		return { fenced: false as const, result };
	}, ASSET_MUTATION_TRANSACTION_POLICY).then((outcome) => {
		if (outcome.fenced) throw new GameUploadTargetFencedError();
		return outcome.result;
	});
}

export function finalizeCompletedWebglSession(
	sessionId: string,
	projectId: number,
	entryKey: string,
	sourceKey: string,
	outbox: WebglReplacementOutboxConfig,
	client: PrismaClient,
	completionClaimToken: string,
	completionResult: {
		status: 'COMPLETED';
		sessionId: string;
		generation: number;
		sizeBytes: number;
		uploadKind: 'WEBGL';
		webglUrl: string;
	},
): Promise<{ oldEntryKey: string }> {
	return withSerializableRetry(async (tx) => {
		await lockExhibitionForProjectFinalization(tx, projectId);
		await lockProjectForUploadMutation(tx, projectId);
		if (!await lockActiveCompletionClaim(tx, sessionId, completionClaimToken)) {
			throw new Error('WebGL upload completion claim is no longer active');
		}
		await assertCurrentFinalizationPolicy(tx, sessionId, projectId);
		const deployment = parseWebglEntryKey(projectId, entryKey);
		if (!deployment) throw new Error('Cannot finalize malformed WebGL entry key');
		const completingSession = await tx.gameUploadSession.findUniqueOrThrow({
			where: { id: sessionId },
			select: { webglDeploymentId: true },
		});
		if (completingSession.webglDeploymentId !== deployment.deploymentId) {
			throw new Error('WebGL public generation does not match its durable reservation');
		}
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
		const oldSourceSession = oldDeployment
			? await tx.gameUploadSession.findFirst({
				where: {
					id: { not: sessionId },
					status: 'COMPLETED',
					uploadKind: 'WEBGL',
					webglDeploymentId: oldDeployment.deploymentId,
				},
				select: { id: true, storageKey: true },
			})
			: null;
		await queueDurableDeletions(tx, [
			...webglDeletionTargetsByEntry(
				projectId,
				project.webglEntryKey === entryKey ? '' : project.webglEntryKey,
				outbox,
				outbox.reason,
			),
			...(oldSourceSession?.storageKey && oldSourceSession.storageKey !== sourceKey
				? [{
					bucket: outbox.protectedBucket,
					storageKey: oldSourceSession.storageKey,
					reason: `${outbox.reason}-source`,
				}]
				: []),
		]);
		await tx.project.update({
			where: { id: projectId },
			data: { webglEntryKey: entryKey },
		});
		if (oldSourceSession?.storageKey && oldSourceSession.storageKey !== sourceKey) {
			await tx.gameUploadSession.update({
				where: { id: oldSourceSession.id },
				data: { storageKey: null },
			});
		}
		const completed = await tx.gameUploadSession.updateMany({
			where: {
				id: sessionId,
				status: { in: ['COMPLETING', 'VERIFYING'] },
				uploadKind: 'WEBGL',
				completionClaimToken,
				webglDeploymentId: deployment.deploymentId,
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

/** Claim durable validation work with SKIP LOCKED for idempotent polling. */
export function claimVerifyingSessions(
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
				JOIN "game_upload_active_sessions" AS active
					ON active."session_id" = session."id"
				WHERE session."status" = 'VERIFYING'
					AND (
						session."completion_claim_until" IS NULL
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
				"completion_last_error" = NULL,
				"updated_at" = clock_timestamp()
			FROM candidates
			WHERE session."id" = candidates."id"
			RETURNING session."id"
		`);
		if (candidates.length === 0) return [];
		return tx.gameUploadSession.findMany({
			where: { id: { in: candidates.map(({ id }) => id) }, completionClaimToken: token },
			orderBy: { updatedAt: 'asc' },
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
		isSessionActive: async (sessionId: string) => (
			await client.gameUploadActiveSession.count({ where: { sessionId } }) === 1
		),
		assertCanCreateSession: (input) => assertCanCreateSession(input, client),
		reservePartCapabilities: (input) => reservePartCapabilities(input, client),
		createSessionReplacingActive: (data: CreateSessionData, limits: DirectUploadQuotaLimits) => (
			createSessionReplacingActive(
				data,
				limits,
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
		expireSessionAndClearActive: (id: string) => cancelSessionAndClearActive(
			id,
			client,
			options.abortBucket,
			'upload-session-expired',
			'EXPIRED',
		),
		queueAbortTask: (target: { key: string; uploadId: string; reason: string }) => (
			client.$transaction((tx) => queueMultipartAbortTask(tx, {
				bucket: options.abortBucket,
				storageKey: target.key,
				uploadId: target.uploadId,
				reason: target.reason,
			}))
		),
		claimCompletion: (input: Parameters<typeof claimCompletion>[0]) => claimCompletion(input, client),
		markVerifying: (input: Parameters<typeof markVerifying>[0]) => markVerifying(input, client),
		claimVerifyingSessions: (
			token: string,
			leaseMs: number,
			limit: number,
		) => claimVerifyingSessions(token, leaseMs, limit, client),
		renewCompletionClaim: async (sessionId: string, token: string, leaseMs: number) => {
			const renewed = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
				UPDATE "game_upload_sessions"
				SET "completion_claim_until" = clock_timestamp()
						+ (${leaseMs} * INTERVAL '1 millisecond'),
					"updated_at" = clock_timestamp()
				WHERE "id" = ${sessionId}
					AND "status" IN ('COMPLETING', 'VERIFYING')
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
					AND "status" IN ('COMPLETING', 'VERIFYING')
					AND "completion_claim_token" = ${token}
					AND "completion_claim_until" > clock_timestamp()
				RETURNING "id"
			`);
			return { count: released.length };
		},
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
		reserveWebglDeployment: (input: {
			sessionId: string;
			completionClaimToken: string;
			candidateDeploymentId: string;
		}) => {
			if (!options.publicBucket) throw new Error('WebGL deployment requires a public bucket');
			return reserveWebglDeployment({
				...input,
				publicBucket: options.publicBucket,
			}, client);
		},
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
			completionResult: {
				status: 'COMPLETED';
				sessionId: string;
				generation: number;
				sizeBytes: number;
				uploadKind: 'WEBGL';
				webglUrl: string;
			},
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
	claimVerifyingSessions(
		token: string,
		leaseMs: number,
		limit: number,
	): Promise<GameUploadSessionSummary[]>;
	markCompletedObjectFailed(input: {
		sessionId: string;
		storageKey: string;
		reason: string;
		completionClaimToken: string;
	}): Promise<{ count: number }>;
	reserveWebglDeployment(input: {
		sessionId: string;
		completionClaimToken: string;
		candidateDeploymentId: string;
	}): Promise<string>;
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
		completionResult: {
			status: 'COMPLETED';
			sessionId: string;
			generation: number;
			sizeBytes: number;
			uploadKind: 'WEBGL';
			webglUrl: string;
		},
	): Promise<{ oldEntryKey: string }>;
}
