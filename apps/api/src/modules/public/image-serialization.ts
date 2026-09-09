import type { ResponsiveImage } from '@pcu/contracts';
import { publicObjectUrl } from '../../shared/public-origin.js';
import {
	deriveImageRenditionStorageKey,
	IMAGE_RENDITION_PROFILES,
} from '../../shared/responsive-image.js';

export interface PublicImageRepresentationRecord {
	role: string;
	bucket: string;
	objectKey: string;
	sizeBytes?: bigint | number;
	state: string;
	width?: number | null;
	height?: number | null;
}

export interface PublicImageSourceRecord {
	storageKey?: string | null;
	width?: number | null;
	height?: number | null;
	card480Height?: number | null;
	display960Height?: number | null;
	representations?: PublicImageRepresentationRecord[];
}

export interface PublicImageSerializationOptions {
	publicAssetOrigin: string;
	publicBucket: string;
	onLegacyFallback?(): Promise<void> | void;
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
	if (representations.length > 0) {
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

	if (!source.storageKey) return undefined;
	await options.onLegacyFallback?.();
	let originalUrl: string;
	try {
		originalUrl = publicObjectUrl(options.publicAssetOrigin, source.storageKey);
	} catch {
		return undefined;
	}
	return {
		original: {
			url: originalUrl,
			...(source.width != null ? { width: source.width } : {}),
			...(source.height != null ? { height: source.height } : {}),
		},
		renditions: IMAGE_RENDITION_PROFILES.flatMap((definition) => {
			const height = source[definition.heightField];
			if (source.width == null || source.width <= definition.width || height == null) return [];
			try {
				return [{
					profile: definition.profile,
					url: publicObjectUrl(
						options.publicAssetOrigin,
						deriveImageRenditionStorageKey(source.storageKey!, definition.profile),
					),
					width: definition.width,
					height,
				}];
			} catch {
				return [];
			}
		}),
	};
}
