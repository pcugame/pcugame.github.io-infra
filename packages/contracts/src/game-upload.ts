import { z } from 'zod';

export type UploadKind = 'GAME' | 'WEBGL';

/** Canonical direct control-plane session kinds. */
export type DirectAssetUploadKind = UploadKind | 'VIDEO' | 'IMAGE' | 'POSTER' | 'DOCUMENT' | 'ATTACHMENT';

/** Canonical owner identity for a direct multipart session. */
export type DirectAssetUploadOwner =
	| { type: 'PROJECT'; id: number }
	| { type: 'EXHIBITION'; id: number };

/** Direct multipart source proof, verified by the processing worker. */
export type DirectUploadSourceIdentity = {
	sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1';
	sourceIdentity: string;
	sourceIdentityBlockSizeBytes: 1048576;
	sourceIdentityBlockDigests: string[];
};

export type DirectGameUploadCreateSessionRequest = {
	/** New UUID per intentional upload, persisted before POST; reuse only for retries.
	 * Optional during rollout for existing clients, which cannot recover a lost create response.
	 */
	clientUploadId?: string;
	voteId?: string;
	originalName: string;
	totalBytes: number;
	uploadKind?: UploadKind;
	/** Advisory only; the worker establishes content type from decoded bytes. */
	declaredMimeType?: string;
	/** Required when the owner is a not-yet-published project submission. */
	submissionItem?: {
		id: string;
		clientToken: string;
	};
} & DirectUploadSourceIdentity;

export type DirectGameUploadPart = {
	partNumber: number;
	etag: string;
	sizeBytes: number;
};

/**
 * Control-plane bound, not an upload concurrency setting.  Clients may choose
 * a smaller batch to keep browser hashing memory bounded.
 */
export const DIRECT_UPLOAD_PART_CAPABILITY_BATCH_MAX = 32;

/** Browser batches at most 8 * 16 MiB (128 MiB) of pending checksums at once. */
export const DIRECT_UPLOAD_BROWSER_PART_BATCH_SIZE = 8;

export type DirectGameUploadPartUrlsRequest = {
	generation: number;
	/** At most DIRECT_UPLOAD_PART_CAPABILITY_BATCH_MAX entries. */
	parts: Array<{
		partNumber: number;
		/** Base64 SHA-256 of precisely the body sent to UploadPart. */
		checksumSha256: string;
	}>;
};

export type DirectGameUploadPartUrlsResponse = {
	generation: number;
	expiresAt: string;
	parts: Array<{
		partNumber: number;
		url: string;
		requiredHeaders: Record<string, string>;
	}>;
};

export type DirectGameUploadCompleteRequest = {
	generation: number;
	parts: DirectGameUploadPart[];
};

export type DirectGameUploadCompletionResponse = {
	status: 'VERIFYING' | 'READY';
	sessionId: string;
	generation: number;
	sizeBytes: number;
};

/** Canonical multipart status used by GAME, WEBGL, and VIDEO control paths. */
export type DirectAssetUploadStatus = {
	sessionId: string;
	/** Phase-1 bridge for existing project-owned callers. */
	projectId?: number;
	exhibitionId?: number;
	owner: DirectAssetUploadOwner;
	kind: DirectAssetUploadKind;
	state: 'ALLOCATING' | 'UPLOADING' | 'COMPLETING' | 'VERIFYING' | 'READY' | 'REJECTED' | 'CANCELLED' | 'EXPIRED';
	generation: number;
	originalName: string;
	totalBytes: number;
	partSizeBytes: number;
	totalParts: number;
	expiresAt: string;
	sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1';
	sourceIdentity: string;
	parts: DirectGameUploadPart[];
};

/** Durable create observation; state must be checked before using the session. */
export const DirectAssetUploadCreationSchema = z.object({
	clientUploadId: z.string().uuid().optional(),
	sessionId: z.string(),
	owner: z.discriminatedUnion('type', [
		z.object({ type: z.literal('PROJECT'), id: z.number().int().positive() }),
		z.object({ type: z.literal('EXHIBITION'), id: z.number().int().positive() }),
	]),
	kind: z.enum(['GAME', 'WEBGL', 'VIDEO', 'IMAGE', 'POSTER', 'DOCUMENT', 'ATTACHMENT']),
	state: z.enum(['ALLOCATING', 'UPLOADING', 'COMPLETING', 'VERIFYING', 'READY', 'REJECTED', 'CANCELLED', 'EXPIRED']),
	generation: z.number().int().positive(),
	partSizeBytes: z.number().int().positive(),
	totalParts: z.number().int().positive(),
	expiresAt: z.string(),
	sourceIdentityAlgorithm: z.literal('SHA256_BLOCK_MANIFEST_V1'),
	sourceIdentity: z.string().regex(/^[a-f0-9]{64}$/),
	sourceIdentityBlockSizeBytes: z.literal(1048576),
});
export type DirectAssetUploadCreation = z.infer<typeof DirectAssetUploadCreationSchema>;

/** NOT_OBSERVED is a point-in-time absence, never proof that a POST failed.
 * Transport/lookup errors carry no operation outcome. Retry POST with the same ID and body.
 */
export const DirectAssetUploadCreationLookupSchema = z.discriminatedUnion('status', [
	z.object({ status: z.literal('NOT_OBSERVED'), clientUploadId: z.string().uuid() }),
	z.object({ status: z.literal('OBSERVED'), session: DirectAssetUploadCreationSchema }),
]);
export type DirectAssetUploadCreationLookup = z.infer<typeof DirectAssetUploadCreationLookupSchema>;
