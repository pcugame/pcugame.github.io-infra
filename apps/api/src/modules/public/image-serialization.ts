import type { ResponsiveImage } from '@pcu/contracts';
import { publicObjectUrl } from '../../shared/public-origin.js';
import { IMAGE_RENDITION_PROFILES } from '../../shared/responsive-image.js';

export interface PublicImageRepresentationRecord {
	role: string;
	bucket: string;
	objectKey: string;
	state: string;
	mimeType?: string;
	sizeBytes?: bigint | number;
	error?: string | null;
	width?: number | null;
	height?: number | null;
}

export interface PublicImageSourceRecord {
	representations?: PublicImageRepresentationRecord[];
}

export interface PublicImageSerializationOptions {
	publicAssetOrigin: string;
	publicBucket: string;
}

/**
 * Serialize public image capabilities from the canonical representation graph.
 * A canonical asset never falls back to legacy columns: a partially migrated
 * row is hidden until its representation set is valid and READY.
 */
export async function serializePublicImage(
	source: PublicImageSourceRecord,
	options: PublicImageSerializationOptions,
): Promise<ResponsiveImage | undefined> {
	const representations = source.representations ?? [];
	const original = representations.find((candidate) => candidate.role === 'ORIGINAL');
	if (!original || original.state !== 'READY' || original.bucket !== options.publicBucket) {
		return undefined;
	}
	return {
			original: {
				url: publicObjectUrl(options.publicAssetOrigin, original.objectKey),
				...(original.width != null ? { width: original.width } : {}),
				...(original.height != null ? { height: original.height } : {}),
			},
			renditions: IMAGE_RENDITION_PROFILES.flatMap((definition) => {
				const rendition = representations.find((candidate) => candidate.role === definition.profile);
				if (!rendition || rendition.state !== 'READY' || rendition.bucket !== options.publicBucket
					|| rendition.height == null) return [];
				return [{
					profile: definition.profile,
					url: publicObjectUrl(options.publicAssetOrigin, rendition.objectKey),
					width: rendition.width ?? definition.width,
					height: rendition.height,
				}];
			}),
	};
}
