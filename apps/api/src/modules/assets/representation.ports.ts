export interface CanonicalAssetRepresentationWrite {
	role: 'ORIGINAL' | 'PLAYBACK' | 'CARD_480' | 'DISPLAY_960' | 'WEBGL_SOURCE';
	bucket: string;
	objectKey: string;
	mimeType: string;
	sizeBytes: bigint;
	state: 'PENDING' | 'VERIFYING' | 'READY' | 'FAILED' | 'DELETING' | 'DELETED';
	width?: number;
	height?: number;
	checksumAlgorithm?: string;
	checksum?: string;
	etag?: string;
	sourceIdentityAlgorithm?: string;
	sourceIdentity?: string;
	error?: string;
}

export interface CanonicalAssetOwner {
	projectId?: number;
	exhibitionId?: number;
}
