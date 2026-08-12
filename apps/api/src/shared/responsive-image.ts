import type { ResponsiveImage } from '@pcu/contracts';

export const PUBLIC_IMAGE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export const IMAGE_RENDITION_PROFILE_ORDER = {
	CARD_480: 0,
	DISPLAY_960: 1,
} as const;

export type ResponsiveImageRenditionRecord = {
	profile: keyof typeof IMAGE_RENDITION_PROFILE_ORDER;
	storageKey: string;
	sourceStorageKey: string;
	width: number;
	height: number;
};

export type ResponsiveImageSourceRecord = {
	storageKey: string;
	width?: number | null;
	height?: number | null;
	imageRenditions?: readonly ResponsiveImageRenditionRecord[];
};

/**
 * Build the one canonical public-image response shape. Only renditions derived
 * from this exact immutable source generation are eligible for serialization.
 */
export function createResponsiveImageSerializer(apiPublicUrl: string) {
	const base = apiPublicUrl.replace(/\/$/, '');
	const publicImageUrl = (storageKey: string) => (
		`${base}/api/public/images/${encodeURIComponent(storageKey)}`
	);

	function serializeResponsiveImage(source: ResponsiveImageSourceRecord): ResponsiveImage {
		const seenProfiles = new Set<ResponsiveImageRenditionRecord['profile']>();
		const currentRenditions = (source.imageRenditions ?? [])
			.filter((rendition) => rendition.sourceStorageKey === source.storageKey)
			.sort((left, right) => (
				IMAGE_RENDITION_PROFILE_ORDER[left.profile]
				- IMAGE_RENDITION_PROFILE_ORDER[right.profile]
				|| left.width - right.width
				|| left.storageKey.localeCompare(right.storageKey)
			))
			.filter((rendition) => {
				if (seenProfiles.has(rendition.profile)) return false;
				seenProfiles.add(rendition.profile);
				return true;
			});

		return {
			original: {
				url: publicImageUrl(source.storageKey),
				...(source.width != null ? { width: source.width } : {}),
				...(source.height != null ? { height: source.height } : {}),
			},
			renditions: currentRenditions.map((rendition) => ({
				profile: rendition.profile,
				url: publicImageUrl(rendition.storageKey),
				width: rendition.width,
				height: rendition.height,
			})),
		};
	}

	return { publicImageUrl, serializeResponsiveImage };
}
