export type UploadKind = 'GAME' | 'WEBGL';

/** New direct control-plane session kinds; legacy chunk sessions remain GAME/WEBGL only. */
export type DirectAssetUploadKind = UploadKind | 'VIDEO' | 'IMAGE' | 'POSTER' | 'DOCUMENT' | 'ATTACHMENT';

/** Canonical owner identity for a direct multipart session. */
export type DirectAssetUploadOwner =
	| { type: 'PROJECT'; id: number }
	| { type: 'EXHIBITION'; id: number };

export type GameUploadCreateSessionRequest = {
	originalName: string;
	totalBytes: number;
	uploadKind?: UploadKind;
};

export type GameUploadSession = {
	sessionId: string;
	chunkSizeBytes: number;
	totalChunks: number;
	expiresAt: string;
	uploadKind: UploadKind;
};

export type GameUploadStatus = {
	sessionId: string;
	projectId: number;
	uploadKind: UploadKind;
	originalName: string;
	totalBytes: number;
	chunkSizeBytes: number;
	totalChunks: number;
	uploadedChunks: number[];
	uploadedCount: number;
	status: string;
	expiresAt: string;
};

export type GameUploadSessionListResponse = {
	items: GameUploadStatus[];
};

export type GameUploadChunkResponse = {
	index: number;
	bytesWritten: number;
	uploadedCount: number;
	totalChunks: number;
};

export type GameUploadCompleteResponse = {
	status: 'COMPLETED';
	storageKey: string;
	sizeBytes: number;
	webglUrl?: string;
};

/**
 * Phase-1 direct-multipart contract.  These are intentionally separate from
 * the legacy chunk contract above: old clients can resume a legacy session
 * while newly-enabled clients never send object bytes to the API.
 */
export type DirectUploadSourceIdentity = {
	sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1';
	sourceIdentity: string;
	sourceIdentityBlockSizeBytes: 1048576;
	sourceIdentityBlockDigests: string[];
};

export type DirectGameUploadCreateSessionRequest = {
	originalName: string;
	totalBytes: number;
	uploadKind?: UploadKind;
	/** Advisory only; the worker establishes content type from decoded bytes. */
	declaredMimeType?: string;
} & DirectUploadSourceIdentity;

export type DirectGameUploadPart = {
	partNumber: number;
	etag: string;
	sizeBytes: number;
};

export type DirectGameUploadPartUrlsRequest = {
	generation: number;
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
