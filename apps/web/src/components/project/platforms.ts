import type { Platform } from '@pcu/contracts';

export const PLATFORM_LABELS = {
	PC: 'PC',
	MOBILE: '모바일',
	WEB: '웹',
} as const satisfies Record<Platform, string>;
