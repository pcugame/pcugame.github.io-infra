export type SiteSettingsData = {
	maxGameFileMb: number;
	maxChunkSizeMb: number;
};

export type UpdateSiteSettingsRequest = Partial<SiteSettingsData>;

export type BannedIpItem = {
	id: number;
	ip: string;
	reason: string;
	createdAt: string;
};

export type BannedIpListResponse = {
	items: BannedIpItem[];
};
