import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import type { SiteSettingsData } from '@pcu/contracts';

export type SiteSettings = SiteSettingsData;

const DEFAULTS: SiteSettings = {
	maxGameFileMb: 5120,
	maxChunkSizeMb: 10,
};

interface SiteSettingsRow {
	maxGameFileMb: number;
	maxChunkSizeMb: number;
}

export interface SiteSettingsRepository {
	loadOrCreate(): Promise<SiteSettingsRow>;
	update(patch: Partial<SiteSettings>): Promise<SiteSettingsRow>;
}

export function createCachedSettingsStore(
	repository: SiteSettingsRepository,
	options: {
		defaults?: SiteSettings;
		warn?: (message: string) => void;
	} = {},
) {
	const defaults = options.defaults ?? DEFAULTS;
	let cache: SiteSettings | null = null;

	async function reload(): Promise<SiteSettings> {
		try {
			const row = await repository.loadOrCreate();
			cache = {
				maxGameFileMb: row.maxGameFileMb,
				maxChunkSizeMb: row.maxChunkSizeMb,
			};
		} catch {
			options.warn?.('Could not load site settings, using defaults');
			cache = { ...defaults };
		}
		return cache;
	}

	return {
		async get(): Promise<SiteSettings> {
			return cache ?? reload();
		},
		reload,
		async update(patch: Partial<SiteSettings>): Promise<SiteSettings> {
			const row = await repository.update(patch);
			cache = {
				maxGameFileMb: row.maxGameFileMb,
				maxChunkSizeMb: row.maxChunkSizeMb,
			};
			return cache;
		},
		invalidate(): void {
			cache = null;
		},
	};
}

const productionStore = createCachedSettingsStore({
	loadOrCreate: () => prisma.siteSetting.upsert({
		where: { id: 'default' },
		create: { id: 'default' },
		update: {},
	}),
	update: (patch) => prisma.siteSetting.upsert({
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
	}),
}, { warn: (message) => logger().warn(message) });

export const getSiteSettings = productionStore.get;
export const reloadSiteSettings = productionStore.reload;
export const updateSiteSettings = productionStore.update;
export const _invalidateCache = productionStore.invalidate;
