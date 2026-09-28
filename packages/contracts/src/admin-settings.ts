export type SiteSettingsData = {
	maxGameFileMb: number;
	maxChunkSizeMb: number;
};

export type UpdateSiteSettingsRequest = Partial<SiteSettingsData>;

export type BannedIpSource = 'AUTO' | 'MANUAL' | 'LEGACY';
export type CreateBannedIpRequest = { ip: string; reason: string };

export type BannedIpItem = {
	source: BannedIpSource;
	active: boolean;
	disabledAt: string | null;
	id: number;
	ip: string;
	reason: string;
	createdAt: string;
};

export type BannedIpListResponse = {
	items: BannedIpItem[];
};
