export type UploadPhase =
	| 'preparing'
	| 'uploading'
	| 'processing'
	| 'completing'
	| 'done'
	| 'error';

export type UploadStatus = 'active' | 'done' | 'error';

export interface UploadTask {
	id: string;
	title: string;
	phase: UploadPhase;
	loadedBytes: number;
	totalBytes: number;
	percent: number;
	status: UploadStatus;
	processingMessage?: string;
	errorMessage?: string;
}

export interface UploadFormDataOptions {
	title: string;
	method?: 'POST' | 'PATCH' | 'PUT';
	processingMessage?: string;
}
