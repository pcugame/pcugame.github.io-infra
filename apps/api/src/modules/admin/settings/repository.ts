import { getSiteSettings, updateSiteSettings } from '../../../shared/site-settings.js';
import type { SiteSettings } from '../../../shared/site-settings.js';

/** Read current site settings (cached) */
export function getSettings(): Promise<SiteSettings> {
	return getSiteSettings();
}

/** Persist a partial settings update and return the new values */
export function patchSettings(patch: Partial<SiteSettings>): Promise<SiteSettings> {
	return updateSiteSettings(patch);
}
