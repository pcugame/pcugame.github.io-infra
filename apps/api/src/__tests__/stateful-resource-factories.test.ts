import { describe, expect, it, vi } from 'vitest';
import type { FastifyPluginAsync } from 'fastify';
import type { Env } from '../config/env.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createLifecycle, startOwnedResources } from '../lib/lifecycle.js';
import {
	createCachedSettingsStore,
	type SiteSettingsRepository,
} from '../shared/site-settings.js';
import { createUploadLimiter } from '../shared/upload-limits.js';
import { createProtectedDownloadLimiter } from '../shared/protected-download-limiter.js';
import {
	createExportProgressStore,
	createExportService,
} from '../modules/admin/export/service.js';
import { defaultTestEnv } from './helpers/app-mocks.js';

function createRateLimitScheduler() {
	let task: (() => void) | undefined;
	const cancel = vi.fn();
	const every = vi.fn((_intervalMs: number, nextTask: () => void) => {
		task = nextTask;
		return { cancel };
	});
	return {
		scheduler: { every },
		cancel,
		run: () => task?.(),
	};
}

describe('stateful resource factories', () => {
	it('does not schedule a timer while stateful modules are imported', async () => {
		const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
		try {
			vi.resetModules();
			await Promise.all([
				import('../lib/lifecycle.js'),
				import('../shared/site-settings.js'),
				import('../shared/upload-limits.js'),
				import('../shared/protected-download-limiter.js'),
				import('../modules/admin/export/service.js'),
			]);
			expect(setIntervalSpy).not.toHaveBeenCalled();
		} finally {
			setIntervalSpy.mockRestore();
		}
	});

	it('creates lifecycle trackers with isolated state and a deterministic drain scheduler', async () => {
		let nowMs = 0;
		const delay = vi.fn(async (ms: number) => { nowMs += ms; });
		const factoryDependencies = {
			clock: { now: () => new Date(nowMs) },
			scheduler: { delay },
		};
		const a = createLifecycle(factoryDependencies);
		const b = createLifecycle(factoryDependencies);

		a.setState('ready');
		a.requestStarted();
		expect(a.getInFlight()).toBe(1);
		expect(b.getInFlight()).toBe(0);
		expect(b.getState()).toBe('starting');
		await expect(a.waitForDrain(100, 40)).resolves.toBe('timeout');
		expect(delay).toHaveBeenCalledTimes(3);

		a.requestFinished();
		await expect(a.waitForDrain(100)).resolves.toBe('drained');
		a.close();
		a.close();
		expect(a.getState()).toBe('shutting_down');
		expect(b.isAcceptingNewWork()).toBe(true);
		b.requestStarted();
		expect(b.getInFlight()).toBe(1);
	});

	it('keeps settings caches isolated and performs no repository or logger work at creation', async () => {
		const logger = { warn: vi.fn() };
		const repository = (maxGameFileMb: number): SiteSettingsRepository => ({
			loadOrCreate: vi.fn().mockResolvedValue({ maxGameFileMb, maxChunkSizeMb: 10 }),
			update: vi.fn().mockImplementation(async (patch) => ({
				maxGameFileMb: patch.maxGameFileMb ?? maxGameFileMb,
				maxChunkSizeMb: patch.maxChunkSizeMb ?? 10,
			})),
		});
		const repositoryA = repository(1_000);
		const repositoryB = repository(2_000);
		const a = createCachedSettingsStore(repositoryA, { logger });
		const b = createCachedSettingsStore(repositoryB, { logger });

		expect(repositoryA.loadOrCreate).not.toHaveBeenCalled();
		expect(repositoryB.loadOrCreate).not.toHaveBeenCalled();
		expect(logger.warn).not.toHaveBeenCalled();
		await expect(a.warmup()).resolves.toMatchObject({ maxGameFileMb: 1_000 });
		await expect(b.get()).resolves.toMatchObject({ maxGameFileMb: 2_000 });
		await a.update({ maxGameFileMb: 1_500 });
		await expect(a.get()).resolves.toMatchObject({ maxGameFileMb: 1_500 });
		await expect(b.get()).resolves.toMatchObject({ maxGameFileMb: 2_000 });

		a.close();
		a.close();
		await expect(a.get()).rejects.toThrow('Settings store is closed');
		await expect(b.get()).resolves.toMatchObject({ maxGameFileMb: 2_000 });
	});

	it('keeps upload semaphore counters isolated and closes only the owned instance', () => {
		const maxConcurrent = vi.fn(() => 2);
		const a = createUploadLimiter(maxConcurrent);
		const b = createUploadLimiter(maxConcurrent);

		expect(maxConcurrent).not.toHaveBeenCalled();
		a.acquire();
		a.acquire();
		expect(a.activeCount()).toBe(2);
		expect(b.activeCount()).toBe(0);

		a.close();
		a.close();
		expect(a.activeCount()).toBe(0);
		expect(() => a.acquire()).toThrow('Upload limiter is closed');
		expect(() => b.acquire()).not.toThrow();
		expect(b.activeCount()).toBe(1);
	});

	it('starts protected limiter timers explicitly and cancels each underlying task exactly once', () => {
		let nowA = 0;
		let nowB = 0;
		const schedulerA = createRateLimitScheduler();
		const schedulerB = createRateLimitScheduler();
		const a = createProtectedDownloadLimiter({
			maxHits: 1,
			windowMs: 1_000,
			sweepIntervalMs: 50,
			clock: { now: () => new Date(nowA) },
			scheduler: schedulerA.scheduler,
		});
		const b = createProtectedDownloadLimiter({
			maxHits: 1,
			windowMs: 1_000,
			sweepIntervalMs: 50,
			clock: { now: () => new Date(nowB) },
			scheduler: schedulerB.scheduler,
		});

		expect(schedulerA.scheduler.every).not.toHaveBeenCalled();
		expect(schedulerB.scheduler.every).not.toHaveBeenCalled();
		a.addBan('10.0.0.1');
		expect(a.isBanned('10.0.0.1')).toBe(true);
		expect(b.isBanned('10.0.0.1')).toBe(false);

		a.start();
		a.start();
		b.start();
		expect(schedulerA.scheduler.every).toHaveBeenCalledOnce();
		expect(schedulerA.scheduler.every).toHaveBeenCalledWith(50, expect.any(Function));
		expect(schedulerB.scheduler.every).toHaveBeenCalledOnce();

		expect(b.check('10.0.0.2')).toBe('ok');
		nowB = 1_001;
		expect(b.check('10.0.0.2')).toBe('ok');
		b.check('10.0.0.3');
		nowB = 2_002;
		schedulerB.run();
		expect(b._bucketSize()).toBe(0);

		a.close();
		a.close();
		expect(schedulerA.cancel).toHaveBeenCalledOnce();
		expect(schedulerB.cancel).not.toHaveBeenCalled();
		expect(() => b.check('10.0.0.4')).not.toThrow();
		b.close();
		b.destroy();
		expect(schedulerB.cancel).toHaveBeenCalledOnce();
	});

	it('keeps export locks and progress isolated and requires an explicit store', () => {
		const a = createExportProgressStore();
		const b = createExportProgressStore();

		a.start(2025, 100);
		expect(a.get()).toMatchObject({ year: 2025, startedAt: 100 });
		expect(b.get()).toBeNull();
		expect(() => a.start(2026, 200)).toThrow();
		expect(() => b.start(2026, 200)).not.toThrow();

		a.close();
		a.close();
		expect(a.get()).toBeNull();
		expect(b.get()).toMatchObject({ year: 2026, startedAt: 200 });
		b.close();
	});

	it('performs no DB, S3, timer, or background work while factories are created', () => {
		const findProjects = vi.fn().mockResolvedValue([]);
		const pathExists = vi.fn().mockResolvedValue(false);
		const ensureDirectory = vi.fn().mockResolvedValue(undefined);
		const saveObject = vi.fn().mockResolvedValue(undefined);
		const rateScheduler = createRateLimitScheduler();
		const settingsRepository: SiteSettingsRepository = {
			loadOrCreate: vi.fn().mockResolvedValue({ maxGameFileMb: 5120, maxChunkSizeMb: 10 }),
			update: vi.fn().mockResolvedValue({ maxGameFileMb: 5120, maxChunkSizeMb: 10 }),
		};

		createLifecycle({
			clock: { now: () => new Date(0) },
			scheduler: { delay: vi.fn() },
		});
		createCachedSettingsStore(settingsRepository, { logger: { warn: vi.fn() } });
		createUploadLimiter(() => 1);
		createProtectedDownloadLimiter({ scheduler: rateScheduler.scheduler });
		createExportService({
			findProjects,
			pathExists,
			ensureDirectory,
			saveObject,
			bucketForKind: () => 'public',
			protectedBucket: 'protected',
			now: () => 0,
			logWarn: vi.fn(),
			logError: vi.fn(),
		}, createExportProgressStore());

		expect(settingsRepository.loadOrCreate).not.toHaveBeenCalled();
		expect(settingsRepository.update).not.toHaveBeenCalled();
		expect(findProjects).not.toHaveBeenCalled();
		expect(pathExists).not.toHaveBeenCalled();
		expect(ensureDirectory).not.toHaveBeenCalled();
		expect(saveObject).not.toHaveBeenCalled();
		expect(rateScheduler.scheduler.every).not.toHaveBeenCalled();
	});

	it('starts compatibility resources only at the explicit owner startup boundary', async () => {
		const firstStart = vi.fn();
		const secondStart = vi.fn().mockResolvedValue(undefined);
		const resources = [
			{ start: firstStart },
			{ start: secondStart },
			{ close: vi.fn() },
		];

		expect(firstStart).not.toHaveBeenCalled();
		expect(secondStart).not.toHaveBeenCalled();
		await startOwnedResources(resources);
		expect(firstStart).toHaveBeenCalledOnce();
		expect(secondStart).toHaveBeenCalledOnce();
	});

	it('starts only the context limiter after ticket 004 removes the legacy route limiter', async () => {
		const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
		const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
		const config: Env = {
			...defaultTestEnv,
			LOG_LEVEL: 'info',
			GOOGLE_CLIENT_IDS: [...defaultTestEnv.GOOGLE_CLIENT_IDS],
			CORS_ALLOWED_ORIGINS: [...defaultTestEnv.CORS_ALLOWED_ORIGINS],
		};
		try {
			vi.resetModules();
			const { createProductionBackendContext } = await import('../backend-context.js');
			const emptyRoute: FastifyPluginAsync = async () => {};
			const findBannedIps = vi.fn().mockResolvedValue([]);
			const context = await createProductionBackendContext(config, {
				factories: {
					prisma: () => ({
						$disconnect: vi.fn(),
						bannedIp: { findMany: findBannedIps },
						siteSetting: {
							upsert: vi.fn().mockResolvedValue({
								maxGameFileMb: 5120,
								maxChunkSizeMb: 10,
							}),
						},
						authSession: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
					} as unknown as PrismaClient),
					routes: () => ({
						auth: emptyRoute,
						devAuth: emptyRoute,
						public: emptyRoute,
						admin: emptyRoute,
						me: emptyRoute,
						assets: emptyRoute,
					}),
				},
			});

			expect(setIntervalSpy).not.toHaveBeenCalled();
			await context.start();
			await context.start();
			expect(findBannedIps).toHaveBeenCalledOnce();
			// One context limiter plus two context maintenance tasks; no route singleton.
			expect(setIntervalSpy).toHaveBeenCalledTimes(3);

			await context.close();
			await context.close();
			expect(clearIntervalSpy).toHaveBeenCalledTimes(3);
		} finally {
			setIntervalSpy.mockRestore();
			clearIntervalSpy.mockRestore();
		}
	});
});
