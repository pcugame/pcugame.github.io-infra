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

export interface GameUploadRepository {
	findSessionById(id: string): Promise<GameUploadSessionRecord | null>;
	createSessionReplacingActive(data: NewGameUploadSession): Promise<{
		session: { id: string };
		replacedSessions: { id: string; s3UploadId: string | null; s3Key: string | null }[];
	}>;
	cancelSessionAndClearActive(id: string): Promise<{ count: number }>;
	queueAbortTask?(target: {
		key: string;
		uploadId: string;
		reason: string;
	}): Promise<unknown>;
	acquirePartClaim?(input: {
		sessionId: string;
		partNumber: number;
		generation: number;
		token: string;
		owner: string;
		now: Date;
		leaseUntil: Date;
	}): Promise<
		| { kind: 'acquired'; token: string }
		| { kind: 'busy' | 'expired' | 'unavailable' }
	>;
	completePartClaim?(input: {
		token: string;
		etag: string;
		now: Date;
	}): Promise<{ accepted: boolean; parts: GameUploadPartRecord[] }>;
	renewPartClaim?(token: string, now: Date, leaseUntil: Date): Promise<{ count: number }>;
	claimCompletion?(input: {
		sessionId: string;
		generation: number;
		token: string;
		now: Date;
		leaseUntil: Date;
	}): Promise<{ count: number; reason: 'state' | 'parts-active' | 'parts-missing' | null }>;
	renewCompletionClaim?(
		sessionId: string,
		token: string,
		now: Date,
		leaseUntil: Date,
	): Promise<{ count: number }>;
	releaseCompletionClaim?(
		sessionId: string,
		token: string,
		now: Date,
		reason: string,
	): Promise<{ count: number }>;
	replaceMultipartGeneration?(input: {
		sessionId: string;
		expectedGeneration: number;
		newUploadId: string;
		reason: string;
	}): Promise<{ replaced: boolean }>;
	upsertPartEtag(sessionId: string, partNumber: number, etag: string): Promise<GameUploadPartRecord[]>;
	transitionToCompleting(sessionId: string): Promise<{ count: number }>;
	findPartsBySessionId(sessionId: string): Promise<GameUploadPartRecord[]>;
	revertToPending(sessionId: string, completionClaimToken?: string): Promise<unknown>;
	markFailed(
		sessionId: string,
		storageKey?: string | null,
		completionClaimToken?: string,
	): Promise<unknown>;
	markCompletedObjectFailed?(input: {
		sessionId: string;
		storageKey: string;
		reason: string;
		completionClaimToken?: string;
	}): Promise<{ count: number }>;
	findStaleCompletingSessions(cutoff: Date): Promise<GameUploadSessionSummary[]>;
	claimStaleCompletingSessions?(
		cutoff: Date,
		now: Date,
		token: string,
		leaseUntil: Date,
		limit: number,
	): Promise<GameUploadSessionSummary[]>;
	findExpiredPendingSessions?(now: Date, limit: number): Promise<GameUploadSessionSummary[]>;
	findSessionsWithExpiredPartClaims?(
		now: Date,
		limit: number,
	): Promise<GameUploadSessionSummary[]>;
	findKnownMultipartUploads?(): Promise<Array<{ s3Key: string | null; s3UploadId: string | null }>>;
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
	listParts?(
		key: string,
		uploadId: string,
		request?: { signal?: AbortSignal },
	): Promise<GameUploadPartRecord[]>;
	listMultipartUploads?(prefix: string, request?: { signal?: AbortSignal }): Promise<Array<{
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
	deleteDurablyQueued?(
		key: string,
		reason: string,
		context: Record<string, unknown>,
	): Promise<void>;
	recordPostCommitCleanupFailure?: () => void;
	logger: {
		error(context: Record<string, unknown>, message: string): void;
		warn(context: Record<string, unknown>, message: string): void;
	};
}
