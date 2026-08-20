import type {
	AssetKind,
	AssetPlaybackStatus,
	InlineAssetKind,
} from '@pcu/contracts';
import type { MultipartPart } from './http-input.js';
import type { UploadLimits } from '../shared/upload-policy.js';
import type { ImageRenditionProfile } from '../shared/responsive-image.js';

export type { ImageRenditionProfile } from '../shared/responsive-image.js';

export interface SavedImageRendition {
	profile: ImageRenditionProfile;
	width: number;
	height: number;
}

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
	/** Canonical raster dimensions. Absent for non-image objects and legacy data. */
	width?: number;
	height?: number;
	/** Physically uploaded derivatives generated from this canonical source. */
	renditions?: SavedImageRendition[];
	uploadIntentIds?: string[];
}

export interface UploadIntentOwner {
	operationId?: string;
	actorId?: number;
	projectId?: number;
	exhibitionId?: number;
}

export interface CollectedUploadFile {
	tmpPath: string;
	fieldname: string;
	filename: string;
}

export interface MultipartRequestHasher {
	hash(payload: unknown, files: readonly CollectedUploadFile[]): Promise<string>;
}

export interface UploadPipelinePort {
	setOwner?(owner: UploadIntentOwner): void;
	trackTempFile(path: string): void;
	processFile(path: string, kind: InlineAssetKind, originalName: string): Promise<SavedUpload>;
	rollbackCommitted(): Promise<void>;
	cleanupTemp(): Promise<void>;
}

/** Context-local guard for upload temp files that must not be scavenged yet. */
export interface ActiveUploadTempRegistry {
	register(temporaryPath: string): void;
	release(temporaryPath: string): void;
	isActive(temporaryPath: string): boolean;
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
	requestHash?: string;
	rollback(): Promise<void>;
	cleanup(): Promise<void>;
}

export interface SingleAssetUploadCoordinator {
	start(
		parts: AsyncIterable<MultipartPart>,
		limits: UploadLimits,
		owner?: UploadIntentOwner,
		beforeUpload?: (requestHash: string) => Promise<UploadIntentOwner>,
	): Promise<ProcessedUpload>;
}

export interface PosterUploadCoordinator {
	start(
		parts: AsyncIterable<MultipartPart>,
		limits: UploadLimits,
		owner?: UploadIntentOwner,
	): Promise<ProcessedUpload>;
}
