import { videoPlaybackRenditionKey, type VideoPlaybackQuality } from '@pcu/contracts';
import { AppError, notFound } from '../../shared/errors.js';

export type AssetDownloadVariant = 'original' | 'playback';
export type DownloadRepresentationRole = 'ORIGINAL' | 'PLAYBACK' | 'WEBGL_SOURCE';

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
	representations: AssetDownloadRepresentation[];
 playbackJobs?: { active: boolean; renditions: { profile: string; state: string; bucket: string; objectKey: string; expiresAt: Date | null }[] }[];
}

export interface ResolvedDownloadRepresentation {
	role: DownloadRepresentationRole;
	bucket: string;
	objectKey: string;
}

function roleFor(variant: AssetDownloadVariant): DownloadRepresentationRole {
	return variant === 'playback' ? 'PLAYBACK' : 'ORIGINAL';
}

/** Phase-2 resolver: physical identity exists only in canonical representations. */
export function resolveDownloadRepresentation(
	asset: AssetDownloadIdentity,
	variant: AssetDownloadVariant,
 profile?: 'native' | 'cap60' | 'cap30',
 quality: VideoPlaybackQuality = 'max',
): ResolvedDownloadRepresentation {
	if (asset.status !== 'READY') throw notFound('Asset is not ready for download');
	if (asset.kind !== 'GAME' && asset.kind !== 'VIDEO' && asset.kind !== 'DOCUMENT' && asset.kind !== 'ATTACHMENT'
		&& asset.kind !== 'IMAGE' && asset.kind !== 'POSTER' && asset.kind !== 'THUMBNAIL') {
		if (asset.kind !== 'WEBGL') {
			throw notFound('Protected download is not available for this asset kind');
		}
	}
	if (variant === 'playback' && asset.kind !== 'VIDEO') {
		throw notFound('Asset playback representation does not exist');
	}

 if (profile || quality !== 'max') {
  const key = videoPlaybackRenditionKey(profile ?? 'native', quality);
  if (variant !== 'playback') throw notFound('Profile requires playback variant');
  const rendition = asset.playbackJobs?.find(job => job.active)?.renditions.find(r => r.profile === key && r.state === 'READY' && r.expiresAt === null);
  if (rendition) return { role: 'PLAYBACK', bucket: rendition.bucket, objectKey: rendition.objectKey };
  if (key !== 'native') throw notFound('Playback profile is unavailable');
 }
	const role = asset.kind === 'WEBGL' ? 'WEBGL_SOURCE' : roleFor(variant);
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
		};
	}
	throw notFound('Asset representation does not exist');
}
