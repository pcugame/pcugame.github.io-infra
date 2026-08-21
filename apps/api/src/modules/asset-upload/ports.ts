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
	expectedTargetAssetId: number | null;
	expectedTargetAssetUpdatedAt: Date | null;
	resultAssetId: number | null;
	resultRepresentationId: string | null;
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
	listParts(bucket: string, key: string, uploadId: string): Promise<DirectPart[]>;
	completeMultipart(bucket: string, key: string, uploadId: string, parts: ReadonlyArray<Pick<DirectPart, 'partNumber' | 'etag'>>): Promise<void>;
	head(bucket: string, key: string): Promise<{ size: number; etag?: string } | null>;
	abortMultipart(bucket: string, key: string, uploadId: string): Promise<void>;
}

export interface DirectPartSigner {
	presignUploadPart(bucket: string, key: string, uploadId: string, partNumber: number, expiresInSeconds: number, checksumSha256: string): Promise<string>;
}

export interface AssetUploadRepository {
	createAllocating(input: Omit<AssetUploadSessionRecord, 'state' | 'uploadId' | 'completionLeaseToken' | 'completionLeaseUntil' | 'completionResult' | 'validationLeaseToken' | 'validationLeaseUntil' | 'expectedTargetAssetId' | 'expectedTargetAssetUpdatedAt' | 'resultAssetId' | 'resultRepresentationId' | 'project' | 'exhibition'>): Promise<AssetUploadSessionRecord>;
	expireStaleAllocations(owner: DirectAssetUploadOwner): Promise<number>;
	setAllocated(sessionId: string, generation: number, uploadId: string): Promise<boolean>;
	cancel(sessionId: string, actorId: number): Promise<{ cancelled: boolean; abort?: { bucket: string; objectKey: string; uploadId: string } }>;
	findById(sessionId: string): Promise<AssetUploadSessionRecord | null>;
	reservePartCapabilities(input: { sessionId: string; actorId: number; generation: number; partCount: number; windowMs: number; maxIssues: number }): Promise<AssetUploadSessionRecord>;
	claimCompletion(input: { sessionId: string; actorId: number; generation: number; token: string; leaseMs: number }): Promise<'claimed' | 'stale' | 'busy' | 'invalid'>;
	renewCompletion(sessionId: string, token: string, leaseMs: number): Promise<boolean>;
	markVerifying(input: { sessionId: string; token: string; generation: number; completedSize: number; result: unknown }): Promise<boolean>;
	revertUploading(sessionId: string, token: string, error: string): Promise<boolean>;
	queueAbort(input: { sessionId: string; bucket: string; objectKey: string; uploadId: string; reason: string }): Promise<void>;
	claimVerifying(kind: DirectAssetUploadKind, limit: number, token: string, leaseMs: number): Promise<AssetUploadSessionRecord[]>;
	renewValidation(sessionId: string, token: string, leaseMs: number): Promise<boolean>;
	commitGameReady(input: { session: AssetUploadSessionRecord; token: string; mimeType: string; checksum?: string; }): Promise<{ assetId: number; representationId: string }>;
	markRejected(sessionId: string, token: string, reason: string): Promise<boolean>;
}

/** Read-capable worker port. It is never passed to Fastify composition. */
export interface AssetUploadValidationStorage {
	stream(bucket: string, key: string, request?: { signal?: AbortSignal }): Promise<{ body: Readable; size: number }>;
}
