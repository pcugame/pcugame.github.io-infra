import {
	RESPONSIVE_IMAGE_PROFILES,
	type ResponsiveImageProfile,
} from '@pcu/contracts';

export const PUBLIC_IMAGE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export type ImageRenditionProfile = ResponsiveImageProfile;

/** Canonical profile metadata used by workers and representation serializers. */
export const IMAGE_RENDITION_PROFILES = RESPONSIVE_IMAGE_PROFILES;
