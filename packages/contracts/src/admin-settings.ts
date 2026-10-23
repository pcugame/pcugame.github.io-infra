import type { SiteSettingsData } from './response-schemas.js';

export type UpdateSiteSettingsRequest = Partial<SiteSettingsData>;
export type CreateBannedIpRequest = { ip: string; reason: string };
