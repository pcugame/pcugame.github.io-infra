export type UploadKind = 'GAME' | 'WEBGL';
export type GameUploadTransport = 'API_CHUNK_PROXY' | 'DIRECT_MULTIPART';

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
	transport?: 'DIRECT_MULTIPART';
	generation?: number;
	sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1';
	sourceIdentity: string;
	sourceIdentityBlockSizeBytes: 1048576;
};

export type GameUploadStatus = {
	sessionId: string;
	projectId: number;
	uploadKind: UploadKind;
	transport?: GameUploadTransport;
	generation?: number;
	originalName: string;
	totalBytes: number;
	chunkSizeBytes: number;
	totalChunks: number;
	uploadedChunks: number[];
	uploadedCount: number;
	status: string;
	expiresAt: string;
	sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1' | null;
	sourceIdentity: string | null;
	sourceIdentityBlockSizeBytes: 1048576 | null;
	parts?: GameUploadUploadedPart[];
};

export type GameUploadUploadedPart = {
	partNumber: number;
	etag: string;
	sizeBytes: number;
};

export type GameUploadPartUrlsRequest = {
	generation: number;
	partNumbers: number[];
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

export type GameUploadVerifyingResponse = {
	status: 'VERIFYING';
	sessionId: string;
	generation: number;
	sizeBytes: number;
};

export type GameUploadCompletionResponse =
	| GameUploadCompleteResponse
	| GameUploadVerifyingResponse;
