import type { SiteSettingsData } from '@pcu/contracts';
import type { PrismaClient } from '../generated/prisma/client.js';

export type SiteSettings = SiteSettingsData;

interface SiteSettingsRow {
	maxGameFileMb: number;
	maxChunkSizeMb: number;
}

export interface SiteSettingsRepository {
	loadOrCreate(): Promise<SiteSettingsRow>;
	update(patch: Partial<SiteSettings>): Promise<SiteSettingsRow>;
}

export interface CachedSettingsStore {
	get(): Promise<SiteSettings>;
	reload(): Promise<SiteSettings>;
	warmup(): Promise<SiteSettings>;
	update(patch: Partial<SiteSettings>): Promise<SiteSettings>;
	invalidate(): void;
	close(): void;
}

export const SETTINGS_CACHE_TTL_MS = 30_000;
export const SETTINGS_WARMUP_MAX_ATTEMPTS = 3;
export const SETTINGS_WARMUP_RETRY_DELAY_MS = 100;

export interface CachedSettingsStoreOptions {
	logger?: { warn(value: unknown, message?: string): void };
	now?: () => number;
	delay?: (ms: number) => Promise<void>;
	ttlMs?: number;
	warmupMaxAttempts?: number;
	warmupRetryDelayMs?: number;
}

export function createCachedSettingsStore(
	repository: SiteSettingsRepository,
	options: CachedSettingsStoreOptions = {},
): CachedSettingsStore {
	const now = options.now ?? Date.now;
	const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const ttlMs = options.ttlMs ?? SETTINGS_CACHE_TTL_MS;
	const warmupMaxAttempts = options.warmupMaxAttempts ?? SETTINGS_WARMUP_MAX_ATTEMPTS;
	const warmupRetryDelayMs = options.warmupRetryDelayMs ?? SETTINGS_WARMUP_RETRY_DELAY_MS;
	let cache: { value: SiteSettings; expiresAt: number } | null = null;
	let loadPromise: Promise<SiteSettings> | null = null;
	let generation = 0;
	let closed = false;

	function assertOpen(): void {
		if (closed) throw new Error('Settings store is closed');
	}

	async function load(): Promise<SiteSettings> {
		assertOpen();
		if (loadPromise) return loadPromise;
		const loadGeneration = generation;
		const pending = (async () => {
			const row = await repository.loadOrCreate();
			assertOpen();
			const value = {
				maxGameFileMb: row.maxGameFileMb,
				maxChunkSizeMb: row.maxChunkSizeMb,
			};
			if (generation === loadGeneration) {
				cache = { value, expiresAt: now() + ttlMs };
			}
			return { ...value };
		})().catch((error) => {
			options.logger?.warn(error, 'Could not load site settings');
			throw error;
		}).finally(() => {
			if (loadPromise === pending) loadPromise = null;
		});
		loadPromise = pending;
		return pending;
	}

	async function reload(): Promise<SiteSettings> {
		assertOpen();
		generation += 1;
		cache = null;
		return load();
	}

	async function warmup(): Promise<SiteSettings> {
		let lastError: unknown;
		for (let attempt = 1; attempt <= warmupMaxAttempts; attempt += 1) {
			try {
				return await reload();
			} catch (error) {
				lastError = error;
				if (attempt < warmupMaxAttempts) await delay(warmupRetryDelayMs);
			}
		}
		throw lastError;
	}

	return {
		async get(): Promise<SiteSettings> {
			assertOpen();
			return cache && now() < cache.expiresAt ? { ...cache.value } : load();
		},
		reload,
		warmup,
		async update(patch: Partial<SiteSettings>): Promise<SiteSettings> {
			assertOpen();
			const row = await repository.update(patch);
			assertOpen();
			const value = {
				maxGameFileMb: row.maxGameFileMb,
				maxChunkSizeMb: row.maxChunkSizeMb,
			};
			generation += 1;
			cache = { value, expiresAt: now() + ttlMs };
			return { ...value };
		},
		invalidate(): void {
			if (closed) return;
			generation += 1;
			cache = null;
		},
		close(): void {
			if (closed) return;
			closed = true;
			generation += 1;
			cache = null;
		},
	};
}

export function createSiteSettingsRepository(
	client: Pick<PrismaClient, 'siteSetting'>,
): SiteSettingsRepository {
	return {
		loadOrCreate: () => client.siteSetting.upsert({
			where: { id: 'default' },
			create: { id: 'default' },
			update: {},
		}),
		update: (patch) => client.siteSetting.upsert({
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
	};
}
