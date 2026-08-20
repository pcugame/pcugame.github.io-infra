export type UploadKind = 'GAME' | 'WEBGL';

export type GameUploadCreateSessionRequest = {
	originalName: string;
	totalBytes: number;
	sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1';
	sourceIdentity: string;
	sourceIdentityBlockSizeBytes: 1048576;
	sourceIdentityBlockDigests: string[];
	uploadKind?: UploadKind;
};

export type GameUploadSession = {
	sessionId: string;
	chunkSizeBytes: number;
	totalChunks: number;
	expiresAt: string;
	uploadKind: UploadKind;
	generation: number;
	sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1';
	sourceIdentity: string;
	sourceIdentityBlockSizeBytes: 1048576;
};

export type GameUploadStatus = {
	sessionId: string;
	projectId: number;
	uploadKind: UploadKind;
	generation: number;
	originalName: string;
	totalBytes: number;
	chunkSizeBytes: number;
	totalChunks: number;
	uploadedCount: number;
	status: string;
	expiresAt: string;
	sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1' | null;
	sourceIdentity: string | null;
	sourceIdentityBlockSizeBytes: 1048576 | null;
	/** Authoritative Garage ListParts result while the session is PENDING. */
	parts: GameUploadUploadedPart[];
};

export type GameUploadUploadedPart = {
	partNumber: number;
	etag: string;
	sizeBytes: number;
};

export type GameUploadPartUrlsRequest = {
	generation: number;
	parts: Array<{
		partNumber: number;
		/** Base64 SHA-256 of this exact multipart body. */
		checksumSha256: string;
	}>;
};

export type GameUploadPartUrl = {
	partNumber: number;
	url: string;
	requiredHeaders: Record<string, string>;
};

export type GameUploadPartUrlsResponse = {
	generation: number;
	expiresAt: string;
	parts: GameUploadPartUrl[];
};

export type GameUploadCompletePart = GameUploadUploadedPart;

export type GameUploadCompleteRequest = {
	generation: number;
	parts: GameUploadCompletePart[];
};

export type GameUploadSessionListResponse = {
	items: GameUploadStatus[];
};

type GameUploadCompletedBase = {
	status: 'COMPLETED';
	sessionId: string;
	generation: number;
	sizeBytes: number;
};

export type GameUploadCompleteResponse =
	| (GameUploadCompletedBase & {
		uploadKind: 'GAME';
		assetId: number;
	})
	| (GameUploadCompletedBase & {
		uploadKind: 'WEBGL';
		webglUrl: string;
	});

export type GameUploadVerifyingResponse = {
	status: 'VERIFYING';
	sessionId: string;
	generation: number;
	sizeBytes: number;
};

export type GameUploadCompletionResponse =
	| GameUploadCompleteResponse
	| GameUploadVerifyingResponse;
