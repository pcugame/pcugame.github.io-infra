export type GameUploadSession = {
	sessionId: string;
	chunkSizeBytes: number;
	totalChunks: number;
	expiresAt: string;
};

export type GameUploadStatus = {
	sessionId: string;
	projectId: number;
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
};
