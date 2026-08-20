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
	sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1';
	sourceIdentity: string;
	sourceIdentityBlockSizeBytes: 1048576;
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
	sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1' | null;
	sourceIdentity: string | null;
	sourceIdentityBlockSizeBytes: 1048576 | null;
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
