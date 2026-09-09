import type {
	GameUploadCompleteResponse,
	SiteSettingsData,
	UploadKind,
	UserRole,
} from '@pcu/contracts';
import type { Readable } from 'node:stream';
import type { StorageRequestOptions } from '../../../application/ports.js';
import type { CompletedUploadSession } from './finalize-completed-upload.service.js';

/** Raised by the repository's serializable active-slot transaction. */
export class ActiveUploadCompletionInProgressError extends Error {
	constructor() {
		super('An upload session is already completing for this project and kind');
		this.name = 'ActiveUploadCompletionInProgressError';
	}
}

export interface GameUploadPartRecord {
	partNumber: number;
	etag: string;
	generation?: number;
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
	uploadedChunks: number[];
	status: string;
	expiresAt: Date;
	s3UploadId: string | null;
	s3Key: string | null;
	storageKey?: string | null;
	parts: GameUploadPartRecord[];
	multipartGeneration?: number;
	completionResult?: unknown;
	completionClaimUntil?: Date | null;
	project: { status: string };
}

export interface GameUploadSessionSummary extends Omit<GameUploadSessionRecord, 'parts' | 'project'> {
	parts?: GameUploadPartRecord[];
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

export type ReplaceMultipartGenerationResult =
	| { replaced: false; durableAbort: null }
	| { replaced: true; durableAbort: DurablyTrackedMultipartAbort | null };

export interface GameUploadRepository {
	findSessionById(id: string): Promise<GameUploadSessionRecord | null>;
	createSessionReplacingActive(data: NewGameUploadSession): Promise<{
		session: { id: string };
		durableAborts: DurablyTrackedMultipartAbort[];
	}>;
	cancelSessionAndClearActive(id: string): Promise<CancelGameUploadResult>;
	queueAbortTask(target: {
		key: string;
		uploadId: string;
		reason: string;
	}): Promise<unknown>;
	acquirePartClaim(input: {
		sessionId: string;
		partNumber: number;
		generation: number;
		token: string;
		owner: string;
		leaseMs: number;
	}): Promise<
		| { kind: 'acquired'; token: string }
		| { kind: 'busy' | 'expired' | 'unavailable' }
	>;
	completePartClaim(input: {
		token: string;
		etag: string;
	}): Promise<{ accepted: boolean; parts: GameUploadPartRecord[] }>;
	renewPartClaim(token: string, leaseMs: number): Promise<{ count: number }>;
	claimCompletion(input: {
		sessionId: string;
		generation: number;
		token: string;
		leaseMs: number;
	}): Promise<{ count: number; reason: 'state' | 'parts-active' | 'parts-missing' | null }>;
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
	replaceMultipartGeneration(input: {
		sessionId: string;
		expectedGeneration: number;
		newUploadId: string;
		reason: string;
	}): Promise<ReplaceMultipartGenerationResult>;
	findPartsBySessionId(sessionId: string): Promise<GameUploadPartRecord[]>;
	revertToPending(sessionId: string, completionClaimToken: string): Promise<unknown>;
	markFailed(
		sessionId: string,
		storageKey: string | null | undefined,
		completionClaimToken: string,
	): Promise<unknown>;
	markCompletedObjectFailed(input: {
		sessionId: string;
		storageKey: string;
		reason: string;
		completionClaimToken: string;
	}): Promise<{ count: number }>;
	claimStaleCompletingSessions(
		cutoff: Date,
		token: string,
		leaseMs: number,
		limit: number,
	): Promise<GameUploadSessionSummary[]>;
	findExpiredPendingSessions(now: Date, limit: number): Promise<GameUploadSessionSummary[]>;
	findSessionsWithExpiredPartClaims(limit: number): Promise<GameUploadSessionSummary[]>;
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
	uploadPart(
		key: string,
		uploadId: string,
		partNumber: number,
		body: Readable,
		contentLength: number,
		request?: { signal?: AbortSignal },
	): Promise<string>;
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
	): Promise<GameUploadPartRecord[]>;
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

export interface GameUploadServiceDependencies {
	repository: GameUploadRepository;
	storage: GameUploadStorage;
	finalizer: {
		finalize(
			session: CompletedUploadSession,
			object: { size: number },
			options?: {
				storageRequest?: StorageRequestOptions;
				assertClaimOwned?: () => Promise<void>;
			},
		): Promise<GameUploadCompleteResponse>;
	};
	settings: { get(): Promise<SiteSettingsData> };
	uploadSlots: { acquire(): void; release(): void };
	clock: { now(): Date };
	ids: { next(): string };
	lifecycle: { isAcceptingNewWork(): boolean };
	config: { uploadChunkSizeMb: number; uploadSessionTtlMinutes: number };
	roleGameMaxBytes(role: UserRole): number;
	storageKey(uploadKind: UploadKind, projectId: number): string;
	deleteOrQueue(key: string, reason: string, context: Record<string, unknown>): Promise<void>;
	wakeDeletionWorker(): void;
	wakeMaintenance(): void;
	recordPostCommitCleanupFailure?: () => void;
	recordUntrackedMultipartCleanupFailure(): void;
	logger: {
		error(context: Record<string, unknown>, message: string): void;
		warn(context: Record<string, unknown>, message: string): void;
		fatal(context: Record<string, unknown>, message: string): void;
	};
}
