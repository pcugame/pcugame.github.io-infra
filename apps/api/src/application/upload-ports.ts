import type { AssetKind, AssetPlaybackStatus } from '@pcu/contracts';
import type { MultipartPart } from './http-input.js';
import type { UploadLimits } from '../shared/upload-limits.js';

export interface SavedUpload {
	storageKey: string;
	playbackStorageKey?: string | null;
	mimeType: string;
	playbackMimeType?: string;
	sizeBytes: number;
	playbackSizeBytes?: number;
	playbackStatus?: AssetPlaybackStatus;
	playbackError?: string;
	originalName: string;
	kind: AssetKind;
}

export interface CollectedUploadFile {
	tmpPath: string;
	fieldname: string;
	filename: string;
}

export interface UploadPipelinePort {
	trackTempFile(path: string): void;
	processFile(path: string, kind: AssetKind, originalName: string): Promise<SavedUpload>;
	rollbackCommitted(): Promise<void>;
	cleanupTemp(): Promise<void>;
}

export interface MultipartCollectorPort {
	collect(
		parts: AsyncIterable<MultipartPart>,
		pipeline: UploadPipelinePort,
		limits: UploadLimits,
	): Promise<{ payloadJson: string; fileParts: CollectedUploadFile[] }>;
}

export interface ProcessedUpload {
	savedFile: SavedUpload;
	rollback(): Promise<void>;
	cleanup(): Promise<void>;
}

export interface SingleAssetUploadCoordinator {
	start(
		parts: AsyncIterable<MultipartPart>,
		limits: UploadLimits,
	): Promise<ProcessedUpload>;
}

export interface PosterUploadCoordinator {
	start(
		parts: AsyncIterable<MultipartPart>,
		limits: UploadLimits,
	): Promise<ProcessedUpload>;
}
