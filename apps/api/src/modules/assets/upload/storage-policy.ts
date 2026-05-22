import type { AssetKind } from '@prisma/client';
import type { UploadObjectOptions } from '../../../lib/storage.js';

const DOWNLOAD_ONLY_OPTIONS: UploadObjectOptions = {
	contentType: 'application/octet-stream',
	contentDisposition: 'attachment',
};

const PUBLIC_IMAGE_OPTIONS: UploadObjectOptions = {
	cacheControl: 'public, max-age=31536000, immutable',
};

export function storageOptionsForAsset(
	kind: AssetKind,
	role: 'original' | 'playback' = 'original',
): UploadObjectOptions {
	if (kind === 'GAME') return DOWNLOAD_ONLY_OPTIONS;
	if (kind === 'VIDEO' && role === 'original') return DOWNLOAD_ONLY_OPTIONS;
	if ((kind === 'IMAGE' || kind === 'POSTER' || kind === 'THUMBNAIL') && role === 'original') {
		return PUBLIC_IMAGE_OPTIONS;
	}
	return {};
}

