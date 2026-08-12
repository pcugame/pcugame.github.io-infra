import { describe, expect, it } from 'vitest';

import {
	RESPONSIVE_IMAGE_PROFILES,
	type ResponsiveImage,
	type ResponsiveImageProfile,
} from './responsive-image.js';

describe('responsive image profile contract', () => {
	it('exposes the ordered runtime definitions used by every workspace', () => {
		expect(RESPONSIVE_IMAGE_PROFILES).toEqual([
			{ profile: 'CARD_480', token: 'card-480', width: 480 },
			{ profile: 'DISPLAY_960', token: 'display-960', width: 960 },
		]);
	});

	it('derives the transport profile type from the runtime definitions', () => {
		const profile: ResponsiveImageProfile = RESPONSIVE_IMAGE_PROFILES[0].profile;
		const rendition: ResponsiveImage['renditions'][number] = {
			profile,
			url: 'https://images.example.test/card.webp',
			width: RESPONSIVE_IMAGE_PROFILES[0].width,
			height: 270,
		};

		expect(rendition.profile).toBe('CARD_480');
	});
});
