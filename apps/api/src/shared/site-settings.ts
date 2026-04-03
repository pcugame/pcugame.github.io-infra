/**
 * Runtime-configurable site settings with in-memory cache.
 *
 * Settings are stored in the `site_settings` table (single row).
 * On first access, the row is auto-created with defaults if missing.
 * Cache is invalidated on update via the admin API.
 */

import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

export interface SiteSettings {
	maxGameFileMb: number;
	maxChunkSizeMb: number;
}

const DEFAULTS: SiteSettings = {
	maxGameFileMb: 5120,    // 5 GB
	maxChunkSizeMb: 10,     // 10 MB per chunk
};

let _cache: SiteSettings | null = null;

/** Get current settings (cached, fast). */
export async function getSiteSettings(): Promise<SiteSettings> {
	if (_cache) return _cache;
	return reloadSiteSettings();
}

/** Reload settings from DB into cache. Call after admin update. */
export async function reloadSiteSettings(): Promise<SiteSettings> {
	try {
		const row = await prisma.siteSetting.upsert({
			where: { id: 'default' },
			create: { id: 'default' },
			update: {},
		});
		_cache = {
			maxGameFileMb: row.maxGameFileMb,
			maxChunkSizeMb: row.maxChunkSizeMb,
		};
	} catch {
		// Table may not exist yet (migration pending)
		logger.warn('Could not load site settings, using defaults');
		_cache = { ...DEFAULTS };
	}
	return _cache;
}

/** Update settings in DB and refresh cache. Returns new values. */
export async function updateSiteSettings(
	patch: Partial<SiteSettings>,
): Promise<SiteSettings> {
	const row = await prisma.siteSetting.upsert({
		where: { id: 'default' },
		create: {
			id: 'default',
			...(patch.maxGameFileMb !== undefined ? { maxGameFileMb: patch.maxGameFileMb } : {}),
			...(patch.maxChunkSizeMb !== undefined ? { maxChunkSizeMb: patch.maxChunkSizeMb } : {}),
		},
		update: {
			...(patch.maxGameFileMb !== undefined ? { maxGameFileMb: patch.maxGameFileMb } : {}),
			...(patch.maxChunkSizeMb !== undefined ? { maxChunkSizeMb: patch.maxChunkSizeMb } : {}),
		},
	});
	_cache = {
		maxGameFileMb: row.maxGameFileMb,
		maxChunkSizeMb: row.maxChunkSizeMb,
	};
	return _cache;
}

/** Invalidate cache (for testing). */
export function _invalidateCache(): void {
	_cache = null;
}
