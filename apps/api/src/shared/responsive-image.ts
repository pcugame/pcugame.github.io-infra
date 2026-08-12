import {
	RESPONSIVE_IMAGE_PROFILES,
	type ResponsiveImage,
	type ResponsiveImageProfile,
} from '@pcu/contracts';

export const PUBLIC_IMAGE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export type ImageRenditionProfile = ResponsiveImageProfile;

const IMAGE_RENDITION_PERSISTENCE_FIELDS = {
	CARD_480: {
		heightField: 'card480Height',
		posterHeightField: 'posterCard480Height',
	},
	DISPLAY_960: {
		heightField: 'display960Height',
		posterHeightField: 'posterDisplay960Height',
	},
} as const satisfies Record<ImageRenditionProfile, {
	heightField: string;
	posterHeightField: string;
}>;

/**
 * The single backend definition for responsive profiles. Persistence stores
 * only the nullable height column named here; width, token and storage key are
 * deterministic properties of the profile and immutable source generation.
 */
export const IMAGE_RENDITION_PROFILES = RESPONSIVE_IMAGE_PROFILES.map((definition) => ({
	...definition,
	...IMAGE_RENDITION_PERSISTENCE_FIELDS[definition.profile],
}));

const RENDITION_KEY_MARKER = '/__pcu_image_rendition__/v1/';
const S3_OBJECT_KEY_MAX_UTF8_BYTES = 1024;

function storageKeyUtf8Bytes(storageKey: string): number {
	return new TextEncoder().encode(storageKey).byteLength;
}

export interface ParsedImageRenditionStorageKey {
	sourceStorageKey: string;
	profile: ImageRenditionProfile;
}

/**
 * Strictly parse the versioned reserved suffix used by deterministic
 * renditions. The canonical re-encode check rejects nested/non-canonical keys.
 *
 * A legacy original can coincidentally have this suffix. Callers authorizing a
 * public request must therefore try parsed-source authorization first and may
 * then fall back to an exact original-key lookup; parsing alone grants no
 * access to an object.
 */
export function parseImageRenditionStorageKey(
	storageKey: string,
): ParsedImageRenditionStorageKey | null {
	if (storageKeyUtf8Bytes(storageKey) > S3_OBJECT_KEY_MAX_UTF8_BYTES) return null;
	for (const definition of IMAGE_RENDITION_PROFILES) {
		const suffix = `${RENDITION_KEY_MARKER}${definition.token}.webp`;
		if (!storageKey.endsWith(suffix)) continue;
		const sourceStorageKey = storageKey.slice(0, -suffix.length);
		if (!sourceStorageKey || parseImageRenditionStorageKey(sourceStorageKey)) return null;
		const canonical = `${sourceStorageKey}${suffix}`;
		if (canonical !== storageKey) return null;
		return { sourceStorageKey, profile: definition.profile };
	}
	return null;
}

export function deriveImageRenditionStorageKey(
	sourceStorageKey: string,
	profile: ImageRenditionProfile,
): string {
	if (!sourceStorageKey) throw new Error('Responsive image source storage key must not be empty');
	if (storageKeyUtf8Bytes(sourceStorageKey) > S3_OBJECT_KEY_MAX_UTF8_BYTES) {
		throw new Error('Responsive image source storage key exceeds 1024 UTF-8 bytes');
	}
	if (parseImageRenditionStorageKey(sourceStorageKey)) {
		throw new Error('A rendition storage key cannot be used as a canonical image source');
	}
	const definition = IMAGE_RENDITION_PROFILES.find((candidate) => candidate.profile === profile);
	if (!definition) throw new Error(`Unknown responsive image profile: ${String(profile)}`);
	const storageKey = `${sourceStorageKey}${RENDITION_KEY_MARKER}${definition.token}.webp`;
	if (storageKeyUtf8Bytes(storageKey) > S3_OBJECT_KEY_MAX_UTF8_BYTES) {
		throw new Error('Derived responsive image storage key exceeds 1024 UTF-8 bytes');
	}
	return storageKey;
}

export type ResponsiveImageSourceRecord = {
	storageKey: string;
	width?: number | null;
	height?: number | null;
	card480Height?: number | null;
	display960Height?: number | null;
};

/**
 * Build the one canonical public-image response shape. A nullable height is
 * the persisted readiness marker. A rendition is advertised only when its
 * source is wider than the profile (so it was not enlarged) and that marker is
 * present. The original remains available for legacy rows without dimensions.
 */
export function createResponsiveImageSerializer(apiPublicUrl: string) {
	const base = apiPublicUrl.replace(/\/$/, '');
	const publicImageUrl = (storageKey: string) => (
		`${base}/api/public/images/${encodeURIComponent(storageKey)}`
	);

	function serializeResponsiveImage(source: ResponsiveImageSourceRecord): ResponsiveImage {
		return {
			original: {
				url: publicImageUrl(source.storageKey),
				...(source.width != null ? { width: source.width } : {}),
				...(source.height != null ? { height: source.height } : {}),
			},
			renditions: IMAGE_RENDITION_PROFILES.flatMap((definition) => {
				const height = source[definition.heightField];
				if (
					source.width == null
					|| source.width <= definition.width
					|| height == null
				) return [];
				let storageKey: string;
				try {
					storageKey = deriveImageRenditionStorageKey(source.storageKey, definition.profile);
				} catch {
					// Legacy rows can predate namespace/length constraints. Preserve their
					// exact original without turning malformed readiness into an API 500.
					return [];
				}
				return [{
					profile: definition.profile,
					url: publicImageUrl(storageKey),
					width: definition.width,
					height,
				}];
			}),
		};
	}

	return { publicImageUrl, serializeResponsiveImage };
}
