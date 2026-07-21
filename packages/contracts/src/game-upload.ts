export type UploadKind = 'GAME' | 'WEBGL';

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
