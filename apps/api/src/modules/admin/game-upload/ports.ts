import type {
	SiteSettingsData,
	UploadKind,
	UserRole,
} from '@pcu/contracts';

/** Raised by the repository's serializable active-slot transaction. */
export class ActiveUploadCompletionInProgressError extends Error {
	constructor() {
		super('An upload session is already completing for this project and kind');
		this.name = 'ActiveUploadCompletionInProgressError';
	}
}

export type DirectUploadQuotaKind =
	| 'ACTOR_ACTIVE_SESSIONS'
	| 'PROJECT_ACTIVE_SESSIONS'
	| 'ACTOR_OUTSTANDING_BYTES'
	| 'PART_URL_REFRESH';

/** Stable application error raised by transaction-bound quota enforcement. */
export class DirectUploadQuotaExceededError extends Error {
	constructor(public readonly quota: DirectUploadQuotaKind) {
		super(`Direct upload quota exceeded: ${quota}`);
		this.name = 'DirectUploadQuotaExceededError';
	}
}

/** The final pointer target changed after this direct session was created. */
export class GameUploadTargetFencedError extends Error {
	readonly terminalStateCommitted = true;

	constructor() {
		super('The GAME replacement target changed while the upload was in progress');
		this.name = 'GameUploadTargetFencedError';
	}
}

export interface DirectUploadQuotaLimits {
	actorActiveSessions: number;
	projectActiveSessions: number;
	actorOutstandingBytes: bigint;
}

export interface GameUploadPartRecord {
	partNumber: number;
	etag: string;
}

export interface GameUploadStoredPartRecord extends GameUploadPartRecord {
	/** S3 ListParts metadata; absent values must fail closed on direct completion. */
	sizeBytes?: number;
}

export interface GameUploadSessionRecord {
	id: string;
	projectId: number;
	userId: number;
	uploadKind: UploadKind;
	originalName: string;
	totalBytes: bigint;
	chunkSizeBytes: number;
	totalChunks: number;
	sourceIdentityAlgorithm?: string | null;
	sourceIdentity?: string | null;
	sourceIdentityBlockSizeBytes?: number | null;
	sourceIdentityBlockManifest?: Uint8Array | null;
	status: string;
	expiresAt: Date;
	s3UploadId: string | null;
	s3Key: string | null;
	storageKey?: string | null;
	multipartGeneration?: number;
	partUrlIssueWindowCount?: number;
	partUrlIssueWindowStartedAt?: Date | null;
	partUrlLastIssuedAt?: Date | null;
	completionResult?: unknown;
	completionClaimUntil?: Date | null;
	webglDeploymentId?: string | null;
	activeSlot?: { sessionId: string } | null;
	project: { status: string };
}

export interface GameUploadSessionSummary extends Omit<GameUploadSessionRecord, 'project'> {
	project?: { status: string };
}

export interface NewGameUploadSession {
	id: string;
	projectId: number;
	userId: number;
	uploadKind: UploadKind;
	originalName: string;
	totalBytes: bigint;
	chunkSizeBytes: number;
	totalChunks: number;
	sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1';
	sourceIdentity: string;
	sourceIdentityBlockSizeBytes: number;
	sourceIdentityBlockManifest: Uint8Array;
	s3UploadId: string;
	s3Key: string;
	expiresAt: Date;
}

/**
 * Evidence returned only after the repository transaction committed the
 * multipart-abort outbox row. Callers may therefore treat a prompt storage
 * abort as best effort without losing application-level tracking.
 */
export interface DurablyTrackedMultipartAbort {
	tracking: 'durable-abort-task-committed';
	sessionId: string;
	key: string;
	uploadId: string;
	reason: string;
}

export type CancelGameUploadResult =
	| { count: 0; durableAbort: null }
	| { count: 1; durableAbort: DurablyTrackedMultipartAbort | null };

export interface GameUploadRepository {
	findSessionById(id: string): Promise<GameUploadSessionRecord | null>;
	isSessionActive(sessionId: string): Promise<boolean>;
	assertCanCreateSession(input: {
		projectId: number;
		userId: number;
		uploadKind: UploadKind;
		totalBytes: bigint;
		limits: DirectUploadQuotaLimits;
	}): Promise<void>;
	reservePartCapabilities(input: {
		sessionId: string;
		actor: { id: number; role: UserRole };
		generation: number;
		partNumbers: number[];
		maxIssuesPerWindow: number;
		issueWindowMs: number;
		quota: DirectUploadQuotaLimits;
	}): Promise<{ session: GameUploadSessionRecord; isRefresh: boolean }>;
	createSessionReplacingActive(
		data: NewGameUploadSession,
		limits: DirectUploadQuotaLimits,
	): Promise<{
		session: { id: string };
		durableAborts: DurablyTrackedMultipartAbort[];
	}>;
	cancelSessionAndClearActive(id: string): Promise<CancelGameUploadResult>;
	expireSessionAndClearActive(id: string): Promise<CancelGameUploadResult>;
	queueAbortTask(target: {
		key: string;
		uploadId: string;
		reason: string;
	}): Promise<unknown>;
	claimCompletion(input: {
		sessionId: string;
		generation: number;
		token: string;
		leaseMs: number;
	}): Promise<{ count: number; reason: 'state' | 'parts-missing' | null }>;
	markVerifying(input: {
		sessionId: string;
		generation: number;
		storageKey: string;
		verifiedSizeBytes: number;
		completionClaimToken: string;
	}): Promise<{ count: number }>;
	renewCompletionClaim(
		sessionId: string,
		token: string,
		leaseMs: number,
	): Promise<{ count: number }>;
	releaseCompletionClaim(
		sessionId: string,
		token: string,
		reason: string,
	): Promise<{ count: number }>;
	revertToPending(sessionId: string, completionClaimToken: string): Promise<unknown>;
	markFailed(
		sessionId: string,
		storageKey: string | null | undefined,
		completionClaimToken: string,
	): Promise<unknown>;
	claimStaleCompletingSessions(
		cutoff: Date,
		token: string,
		leaseMs: number,
		limit: number,
	): Promise<GameUploadSessionSummary[]>;
	findExpiredPendingSessions(now: Date, limit: number): Promise<GameUploadSessionSummary[]>;
	findKnownMultipartUploads(): Promise<Array<{ s3Key: string | null; s3UploadId: string | null }>>;
	findActiveSessionsForListing(
		projectId: number,
		options: { userId?: number },
	): Promise<GameUploadSessionSummary[]>;
	findExhibitionById(id: number): Promise<{
		id: number;
		year: number;
		title: string;
		isUploadEnabled: boolean;
	} | null>;
}

export interface GameUploadStorage {
	createMultipart(key: string, request?: { signal?: AbortSignal }): Promise<string>;
	abortMultipart(
		key: string,
		uploadId: string,
		request?: { signal?: AbortSignal },
	): Promise<void>;
	completeMultipart(
		key: string,
		uploadId: string,
		parts: GameUploadPartRecord[],
		request?: { signal?: AbortSignal },
	): Promise<void>;
	listParts(
		key: string,
		uploadId: string,
		request?: { signal?: AbortSignal },
	): Promise<GameUploadStoredPartRecord[]>;
	listMultipartUploads(prefix: string, request?: { signal?: AbortSignal }): Promise<Array<{
		key: string;
		uploadId: string;
		initiated?: Date;
	}>>;
	head(key: string, request?: { signal?: AbortSignal }): Promise<{
		size: number;
		contentType: string;
	} | null>;
}

/** Capability-only port: it cannot complete, abort, delete, or relay bytes. */
export interface GameUploadPartSigner {
	presignUploadPart(
		key: string,
		uploadId: string,
		partNumber: number,
		expiresInSeconds: number,
		checksumSha256: string,
	): Promise<string>;
}

/**
 * Deliberately read-only session authority for the UploadPart capability issuer.
 * Expiration cleanup and every multipart mutation remain owned by maintenance
 * and completion use-cases rather than being reachable from signing code.
 */
export interface GameUploadPartSigningRepository {
	reservePartCapabilities(input: {
		sessionId: string;
		actor: { id: number; role: UserRole };
		generation: number;
		partNumbers: number[];
		maxIssuesPerWindow: number;
		issueWindowMs: number;
		quota: DirectUploadQuotaLimits;
	}): Promise<{ session: GameUploadSessionRecord; isRefresh: boolean }>;
}

export interface GameUploadPartSigningDependencies {
	repository: GameUploadPartSigningRepository;
	partSigner: GameUploadPartSigner;
	clock: { now(): Date };
	config: {
		uploadPartUrlBatchMax: number;
		uploadPartUrlTtlSeconds: number;
		uploadPartUrlRefreshMax: number;
		uploadPartUrlRefreshWindowMs: number;
		directUploadQuota: DirectUploadQuotaLimits;
	};
	logger: {
		info?(context: Record<string, unknown>, message: string): void;
	};
}

export interface GameUploadServiceDependencies {
	repository: GameUploadRepository;
	storage: GameUploadStorage;
	partSigner: GameUploadPartSigner;
	settings: { get(): Promise<SiteSettingsData> };
	clock: { now(): Date };
	ids: { next(): string };
	lifecycle: { isAcceptingNewWork(): boolean };
	authorizeProjectWrite(
		actor: { id: number; role: UserRole },
		projectId: number,
	): Promise<void>;
	config: {
		uploadChunkSizeMb: number;
		uploadSessionTtlMinutes: number;
		uploadPartUrlBatchMax: number;
		uploadPartUrlTtlSeconds: number;
		uploadPartUrlRefreshMax: number;
		uploadPartUrlRefreshWindowMs: number;
		directUploadQuota: DirectUploadQuotaLimits;
	};
	roleGameMaxBytes(role: UserRole): number;
	storageKey(uploadKind: UploadKind, projectId: number): string;
	deleteOrQueue(key: string, reason: string, context: Record<string, unknown>): Promise<void>;
	wakeDeletionWorker(): void;
	wakeMaintenance(): void;
	recordPostCommitCleanupFailure?: () => void;
	recordUntrackedMultipartCleanupFailure(): void;
	logger: {
		info?(context: Record<string, unknown>, message: string): void;
		error(context: Record<string, unknown>, message: string): void;
		warn(context: Record<string, unknown>, message: string): void;
		fatal(context: Record<string, unknown>, message: string): void;
	};
}
