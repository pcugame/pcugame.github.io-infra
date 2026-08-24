import type { AssetUploadKind, AssetUploadSessionState } from '../../generated/prisma/client.js';
import type { Readable } from 'node:stream';

export type DirectAssetUploadKind = Extract<AssetUploadKind, 'GAME' | 'WEBGL' | 'VIDEO' | 'IMAGE' | 'POSTER'>;
export type DirectAssetUploadState = AssetUploadSessionState;

export type DirectAssetUploadOwner =
	| { type: 'PROJECT'; id: number }
	| { type: 'EXHIBITION'; id: number };

export interface AssetUploadSessionRecord {
	id: string;
	projectId: number | null;
	exhibitionId: number | null;
	userId: number;
	kind: DirectAssetUploadKind;
	state: DirectAssetUploadState;
	originalName: string;
	declaredMimeType: string;
	totalBytes: bigint;
	partSizeBytes: number;
	totalParts: number;
	bucket: string;
	objectKey: string;
	uploadId: string | null;
	generation: number;
	sourceIdentityAlgorithm: string;
	sourceIdentity: string;
	sourceIdentityBlockSizeBytes: number;
	sourceIdentityBlockManifest: unknown;
	completionLeaseToken: string | null;
	completionLeaseUntil: Date | null;
	completionResult: unknown;
	validationLeaseToken: string | null;
	validationLeaseUntil: Date | null;
	validationAttemptCount?: number;
	expectedTargetAssetId: number | null;
	expectedTargetAssetUpdatedAt: Date | null;
	resultAssetId: number | null;
	resultRepresentationId: string | null;
	submissionItemId?: string | null;
	expiresAt: Date;
	project?: { status: string; exhibitionId: number } | null;
	exhibition?: { id: number } | null;
}

export interface DirectPart {
	partNumber: number;
	etag: string;
	sizeBytes: number;
}

export interface DirectMultipartControlStorage {
	createMultipart(bucket: string, key: string, contentType: string): Promise<string>;
	listParts(bucket: string, key: string, uploadId: string, request?: { signal?: AbortSignal }): Promise<DirectPart[]>;
	completeMultipart(bucket: string, key: string, uploadId: string, parts: ReadonlyArray<Pick<DirectPart, 'partNumber' | 'etag'>>, request?: { signal?: AbortSignal }): Promise<void>;
	head(bucket: string, key: string, request?: { signal?: AbortSignal }): Promise<{ size: number; etag?: string } | null>;
	abortMultipart(bucket: string, key: string, uploadId: string): Promise<void>;
}

/**
 * Maintenance-only S3 metadata capability.  It deliberately has no object
 * read or UploadPart body method, and is never passed to Fastify routes.
 */
export interface AssetUploadRecoveryStorage extends Pick<
	DirectMultipartControlStorage,
	'listParts' | 'completeMultipart' | 'head'
> {
	listMultipartUploads(
		bucket: string,
		prefix: string,
		request?: { signal?: AbortSignal },
	): Promise<Array<{ key: string; uploadId: string; initiated?: Date }>>;
}

export interface DirectPartSigner {
	presignUploadPart(bucket: string, key: string, uploadId: string, partNumber: number, expiresInSeconds: number, checksumSha256: string): Promise<string>;
}

export interface AssetUploadRepository {
	createAllocating(input: Omit<AssetUploadSessionRecord, 'state' | 'uploadId' | 'completionLeaseToken' | 'completionLeaseUntil' | 'completionResult' | 'validationLeaseToken' | 'validationLeaseUntil' | 'validationAttemptCount' | 'expectedTargetAssetId' | 'expectedTargetAssetUpdatedAt' | 'resultAssetId' | 'resultRepresentationId' | 'submissionItemId' | 'project' | 'exhibition'> & {
		submissionItemId?: string | null;
		submissionClientToken?: string;
	}): Promise<AssetUploadSessionRecord>;
	expireStaleAllocations(owner: DirectAssetUploadOwner): Promise<number>;
	/** Close a persisted ALLOCATING row when CreateMultipart has no known upload ID. */
	failAllocation(input: { sessionId: string; generation: number; reason: string }): Promise<boolean>;
	setAllocated(sessionId: string, generation: number, uploadId: string): Promise<boolean>;
	cancel(sessionId: string, actorId: number): Promise<{ cancelled: boolean; abort?: { bucket: string; objectKey: string; uploadId: string } }>;
	findById(sessionId: string): Promise<AssetUploadSessionRecord | null>;
	/**
	 * Atomically reserve from the session-lifetime capability budget.  The
	 * persisted counter never resets, so API restarts cannot mint unbounded
	 * replacement URLs.
	 */
	reservePartCapabilities(input: {
		sessionId: string;
		actorId: number;
		generation: number;
		partCount: number;
		maxRefreshIssues: number;
	}): Promise<AssetUploadSessionRecord>;
	claimCompletion(input: { sessionId: string; actorId: number; generation: number; token: string; leaseMs: number }): Promise<'claimed' | 'stale' | 'busy' | 'invalid'>;
	renewCompletion(sessionId: string, token: string, leaseMs: number): Promise<boolean>;
	markVerifying(input: { sessionId: string; token: string; generation: number; completedSize: number; result: unknown }): Promise<boolean>;
	revertUploading(sessionId: string, generation: number, token: string, error: string): Promise<boolean>;
	queueAbort(input: { sessionId: string; bucket: string; objectKey: string; uploadId: string; reason: string }): Promise<void>;
	claimVerifying(kind: DirectAssetUploadKind, limit: number, token: string, leaseMs: number): Promise<AssetUploadSessionRecord[]>;
	renewValidation(sessionId: string, token: string, leaseMs: number): Promise<boolean>;
	commitGameReady(input: { session: AssetUploadSessionRecord; token: string; mimeType: string; checksum?: string; }): Promise<{ assetId: number; representationId: string }>;
	markRejected(sessionId: string, generation: number, token: string, reason: string): Promise<boolean>;

	/** DB-clock, row-locked expiry.  UPLOADING rows enqueue abort work atomically. */
	expireTimedOutSessions(limit: number): Promise<{ expired: number; aborts: number }>;
	/** Take over only a lease already expired according to PostgreSQL's clock. */
	claimExpiredCompletions(input: { limit: number; token: string; leaseMs: number }): Promise<AssetUploadSessionRecord[]>;
	/** Return a recoverable incomplete upload to the browser, or terminalize it when expired. */
	releaseRecoveredCompletion(input: { sessionId: string; generation: number; token: string; reason: string }): Promise<'released' | 'expired' | 'lost'>;
	/** A completed object with the wrong shape can no longer be resumed safely. */
	rejectRecoveredCompletion(input: { sessionId: string; generation: number; token: string; reason: string }): Promise<boolean>;
	/** Queue old uploads in the reserved namespace only when no live session owns their key. */
	queueUnknownMultipartAborts(input: { bucket: string; uploads: Array<{ key: string; uploadId: string }> }): Promise<number>;
}

/** Read-capable worker port. It is never passed to Fastify composition. */
export interface AssetUploadValidationStorage {
	stream(bucket: string, key: string, request?: { signal?: AbortSignal }): Promise<{ body: Readable; size: number }>;
}
