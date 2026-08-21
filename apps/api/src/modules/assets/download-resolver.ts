import { AppError, notFound } from '../../shared/errors.js';

export type AssetDownloadVariant = 'original' | 'playback';
export type DownloadRepresentationRole = 'ORIGINAL' | 'PLAYBACK';

export interface AssetDownloadRepresentation {
	role: string;
	bucket: string;
	objectKey: string;
	state: string;
}

export interface AssetDownloadIdentity {
	id: number;
	kind: string;
	status: string;
	storageKey: string | null;
	playbackStorageKey: string | null;
	playbackStatus: string;
	representations: AssetDownloadRepresentation[];
}

export interface ResolvedDownloadRepresentation {
	role: DownloadRepresentationRole;
	bucket: string;
	objectKey: string;
	source: 'canonical' | 'legacy';
}

function roleFor(variant: AssetDownloadVariant): DownloadRepresentationRole {
	return variant === 'playback' ? 'PLAYBACK' : 'ORIGINAL';
}

/** Representation-first Phase-1 resolver. Legacy identity is used only on a true row miss. */
export function resolveDownloadRepresentation(
	asset: AssetDownloadIdentity,
	variant: AssetDownloadVariant,
	legacyProtectedBucket: string,
): ResolvedDownloadRepresentation {
	if (asset.status !== 'READY') throw notFound('Asset is not ready for download');
	if (asset.kind !== 'GAME' && asset.kind !== 'VIDEO') {
		throw notFound('Protected download is not available for this asset kind');
	}
	if (variant === 'playback' && asset.kind !== 'VIDEO') {
		throw notFound('Asset playback representation does not exist');
	}

	const role = roleFor(variant);
	const canonical = asset.representations.find((representation) => representation.role === role);
	if (canonical) {
		if (canonical.state !== 'READY') {
			throw notFound('Asset representation is not ready for download');
		}
		if (!canonical.bucket.trim() || !canonical.objectKey.trim()) {
			throw new AppError(
				500,
				'Canonical asset representation is malformed',
				'INTERNAL_ERROR',
			);
		}
		return {
			role,
			bucket: canonical.bucket,
			objectKey: canonical.objectKey,
			source: 'canonical',
		};
	}

	const objectKey = variant === 'original'
		? asset.storageKey
		: asset.playbackStatus === 'READY' ? asset.playbackStorageKey : null;
	if (!objectKey?.trim()) throw notFound('Asset representation does not exist');
	if (!legacyProtectedBucket.trim()) {
		throw new AppError(500, 'Legacy protected bucket is not configured', 'INTERNAL_ERROR');
	}
	return {
		role,
		bucket: legacyProtectedBucket,
		objectKey,
		source: 'legacy',
	};
}
