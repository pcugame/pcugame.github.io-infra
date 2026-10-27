/**
 * Canonical responsive-image profiles shared by producers and consumers.
 * Array order is the public rendition order.
 */
export const RESPONSIVE_IMAGE_PROFILES = [
	{ profile: 'CARD_480', token: 'card-480', width: 480 },
	{ profile: 'DISPLAY_960', token: 'display-960', width: 960 },
] as const;

export type ResponsiveImageProfile = (typeof RESPONSIVE_IMAGE_PROFILES)[number]['profile'];

export const IMAGE_SOURCE_WIDTHS = [320, 480, 768, 960, 1440, 1920] as const;

export type ResponsiveImage = {
	sources?: Array<{ url: string; width: number; height: number }>;
	original: {
		url: string;
		width?: number;
		height?: number;
	};
	renditions: Array<{
		profile: ResponsiveImageProfile;
		url: string;
		width: number;
		height: number;
	}>;
};
