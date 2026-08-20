import { Readable, Writable } from 'node:stream';
import type { FastifyPluginAsync } from 'fastify';
import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../config/env.js';
import type {
	AppLogger,
	FileSystem,
	GoogleTokenVerifier,
	ObjectStorage,
	Scheduler,
	SettingsStore,
} from '../application/ports.js';
import {
	createMaintenanceSchedule,
	createProductionBackendContext,
	createSingleFlightUploadRecovery,
	type BackendRoutes,
	type ProductionResourceFactories,
} from '../backend-context.js';
import { buildApp } from '../app.js';
import { createProtectedDownloadLimiter } from '../shared/protected-download-limiter.js';
import { routeRuntimeContractsFor } from '../shared/http-route-schemas.js';
import { defaultTestEnv } from './helpers/app-mocks.js';
import { createScriptedBackendPersistence } from './helpers/backend-persistence.js';
import { ownedTestUploadLifecycleResource } from './helpers/upload-lifecycle.js';

const emptyRoute: FastifyPluginAsync = async () => {};
const emptyRoutes: BackendRoutes = {
	auth: emptyRoute,
	devAuth: emptyRoute,
	public: emptyRoute,
	admin: emptyRoute,
	me: emptyRoute,
	assets: emptyRoute,
};

const testLogger: AppLogger = {
	child: () => testLogger,
	trace: () => {},
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	fatal: () => {},
};

const testConfig: Env = {
	...defaultTestEnv,
	LOG_LEVEL: 'info',
	GOOGLE_CLIENT_IDS: [...defaultTestEnv.GOOGLE_CLIENT_IDS],
	CORS_ALLOWED_ORIGINS: [...defaultTestEnv.CORS_ALLOWED_ORIGINS],
};

const fileSystem: FileSystem = {
	temporaryDirectory: () => '/tmp',
	stat: async () => ({ size: 0 }),
	access: async () => {},
	mkdir: async () => {},
	ensurePrivateDirectory: async () => {},
	rename: async () => {},
	remove: async () => {},
	readRange: async () => Buffer.alloc(0),
	createReadStream: () => Readable.from([]),
	createWriteStream: () => new Writable({ write(_chunk, _encoding, done) { done(); } }),
};

const storage: ObjectStorage = {
	upload: async () => {},
	presign: async () => 'https://storage.test/object',
	presignUploadPart: async () => 'https://storage.test/upload-part',
	delete: async () => {},
	head: async () => null,
	readRange: async () => Buffer.alloc(0),
	stream: async () => null,
	listKeys: async () => [],
	listKeyPage: async () => ({ keys: [], isTruncated: false }),
	deleteKeys: async (_bucket, keys) => ({ deleted: [...keys], failures: [] }),
	createMultipart: async () => 'upload-id',
	uploadPart: async () => 'etag',
	completeMultipart: async () => {},
	abortMultipart: async () => {},
	listParts: async () => [],
	listMultipartUploads: async () => [],
};

function settingsHarness(label: string, events: string[], initialMaxGameFileMb = 5120) {
	let value = { maxGameFileMb: initialMaxGameFileMb, maxChunkSizeMb: 10 };
	const start = vi.fn(async () => {});
	const close = vi.fn(() => { events.push(label ? `${label}:settings` : 'settings'); });
	const store: SettingsStore = {
		get: vi.fn(async () => value),
		update: vi.fn(async (patch) => {
			value = { ...value, ...patch };
			return value;
		}),
		invalidate: vi.fn(),
	};
	return { store, start, close };
}

function fakeS3(label: string, events: string[]): S3Client {
	return {
		destroy: vi.fn(() => { events.push(label ? `${label}:s3` : 's3'); }),
		send: vi.fn(async () => ({ Uploads: [], IsTruncated: false })),
	} as unknown as S3Client;
}

function schedulerHarness() {
	const tasks: Array<{ task: () => void | Promise<void>; cancel: ReturnType<typeof vi.fn> }> = [];
	const scheduler: Scheduler = {
		every: vi.fn((_interval, task) => {
			const scheduled = { task, cancel: vi.fn() };
			tasks.push(scheduled);
			return scheduled;
		}),
		delay: vi.fn(async () => {}),
	};
	return { scheduler, tasks };
}

describe('production BackendContext resource ownership', () => {
	it('rejects an unsafe upload directory before startup recovery can enumerate or delete', async () => {
		const ensurePrivateDirectory = vi.fn(async () => {
			throw new Error('final upload directory is a symlink');
		});
		const listDirectoryEntries = vi.fn(async () => []);
		const remove = vi.fn(async () => {});
		const unsafeFileSystem: FileSystem = {
			...fileSystem,
			ensurePrivateDirectory,
			listDirectoryEntries,
			remove,
		};
		const context = await createProductionBackendContext(testConfig, {
			persistence: createScriptedBackendPersistence(),
			routes: emptyRoutes,
			resources: {
				uploadLifecycle: ownedTestUploadLifecycleResource(),
				fileSystem: { value: unsafeFileSystem, ownership: 'borrowed' },
				logger: { value: testLogger, ownership: 'borrowed' },
				settings: { value: settingsHarness('', []).store, ownership: 'borrowed' },
				s3: { value: fakeS3('', []), ownership: 'borrowed' },
			},
		});

		await expect(context.start()).rejects.toThrow('final upload directory is a symlink');
		expect(ensurePrivateDirectory).toHaveBeenCalledWith('/tmp/pcugame-upload');
		expect(listDirectoryEntries).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
	});

	it('coalesces the complete upload recovery sequence across overlapping callers', async () => {
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => { release = resolve; });
		let entered!: () => void;
		const started = new Promise<void>((resolve) => { entered = resolve; });
		const gameRecovery = vi.fn(async () => {
			entered();
			await barrier;
		});
		const tempSweep = vi.fn(async () => {});
		const recover = createSingleFlightUploadRecovery(gameRecovery, tempSweep);
		const alreadyAborted = new AbortController();
		alreadyAborted.abort();
		const abortedCall = recover(alreadyAborted.signal);
		const first = recover();
		await started;
		const overlapping = recover();
		expect(overlapping).toBe(first);
		release();
		await Promise.all([abortedCall, first, overlapping]);
		expect(gameRecovery).toHaveBeenCalledOnce();
		expect(tempSweep).toHaveBeenCalledOnce();
	});

	it('waits for an in-flight orphan reaper before closing its maintenance schedule', async () => {
		const harness = schedulerHarness();
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => { release = resolve; });
		let entered!: () => void;
		const started = new Promise<void>((resolve) => { entered = resolve; });
		const schedule = createMaintenanceSchedule(
			harness.scheduler,
			{ now: () => new Date(0) },
			{
				recoverStaleUploads: vi.fn(),
				purgeExpiredSessions: vi.fn().mockResolvedValue(0),
				reapOrphans: vi.fn(async () => {
					entered();
					await barrier;
				}),
			},
			testLogger,
		);

		schedule.start();
		const running = Promise.resolve(harness.tasks[1]!.task());
		await started;
		let closed = false;
		const closing = schedule.close().then(() => { closed = true; });
		await Promise.resolve();
		expect(closed).toBe(false);
		expect(harness.tasks.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true);
		release();
		await Promise.all([running, closing]);
		expect(closed).toBe(true);
	});

	it('creates isolated stateful resources and closes only A-owned resources once', async () => {
		const events: string[] = [];
		const aScheduler = schedulerHarness();
		const bScheduler = schedulerHarness();
		const borrowedLogger = { ...testLogger, close: vi.fn() };
		const config: Env = { ...testConfig, UPLOAD_MAX_CONCURRENT: 1 };
		const create = (label: string, scheduler: Scheduler, setting: number) => {
			const settings = settingsHarness(label, events, setting);
			const s3 = fakeS3(label, events);
			return createProductionBackendContext(config, {
				persistence: createScriptedBackendPersistence(),
				routes: emptyRoutes,
				factories: { scheduler: () => scheduler },
				resources: {
					uploadLifecycle: ownedTestUploadLifecycleResource(),
					logger: { value: borrowedLogger, ownership: 'borrowed' },
					settings: {
						value: settings.store,
						ownership: 'owned',
						start: settings.start,
						close: settings.close,
					},
					s3: {
						value: s3,
						ownership: 'owned',
						close: () => s3.destroy(),
					},
				},
			});
		};

		const a = await create('a', aScheduler.scheduler, 1000);
		const b = await create('b', bScheduler.scheduler, 2000);

		a.lifecycle.setState('ready');
		a.lifecycle.requestStarted();
		expect(a.lifecycle.inFlight()).toBe(1);
		expect(b.lifecycle.inFlight()).toBe(0);
		a.uploadLimiter.acquire();
		expect(() => a.uploadLimiter.acquire()).toThrow();
		expect(() => b.uploadLimiter.acquire()).not.toThrow();
		a.protectedDownloads.addBan('10.0.0.1');
		expect(a.protectedDownloads.isBanned('10.0.0.1')).toBe(true);
		expect(b.protectedDownloads.isBanned('10.0.0.1')).toBe(false);
		await a.settings.update({ maxGameFileMb: 1500 });
		await expect(a.settings.get()).resolves.toMatchObject({ maxGameFileMb: 1500 });
		await expect(b.settings.get()).resolves.toMatchObject({ maxGameFileMb: 2000 });

		await a.start();
		await b.start();
		expect(aScheduler.tasks).toHaveLength(4);
		expect(bScheduler.tasks).toHaveLength(4);
		await a.close();
		await a.close();

		expect(events).toEqual(['a:settings', 'a:s3']);
		expect(aScheduler.tasks.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true);
		expect(bScheduler.tasks.every(({ cancel }) => cancel.mock.calls.length === 0)).toBe(true);
		expect(() => b.protectedDownloads.check('10.0.0.2')).not.toThrow();
		expect(borrowedLogger.close).not.toHaveBeenCalled();
		expect(a.resourceOwnership).toContainEqual({ name: 'logger', ownership: 'borrowed' });
		expect(a.resourceOwnership).toContainEqual({ name: 'settings', ownership: 'owned' });
		await b.close();
		expect(events).toEqual(['a:settings', 'a:s3', 'b:settings', 'b:s3']);
	});

	it.each([
		['s3', []],
		['storage', ['s3']],
		['uploadLimiter', ['settings', 's3']],
		['lifecycle', ['upload', 'settings', 's3']],
		['routes', ['protected', 'lifecycle', 'upload', 'settings', 's3']],
	] as const)('preserves the %s construction error and closes prior resources in reverse', async (failure, expected) => {
		const events: string[] = [];
		const original = new Error(`failure:${failure}`);
		const fail = <T>(name: string, value: T): T => {
			if (name === failure) throw original;
			return value;
		};
		const settings = settingsHarness('', events, 1);
		const s3 = fakeS3('', events);
		const factories: Partial<ProductionResourceFactories> = {
			logger: () => fail('logger', testLogger),
			clock: () => fail('clock', { now: () => new Date(0) }),
			ids: () => fail('ids', { next: () => 'id' }),
			scheduler: () => fail('scheduler', schedulerHarness().scheduler),
			fileSystem: () => fail('fileSystem', fileSystem),
			googleTokens: () => fail('googleTokens', { verify: async () => undefined }),
			s3: () => fail('s3', s3),
			storage: () => fail('storage', storage),
			uploadLimiter: () => fail('uploadLimiter', {
				acquire: () => {},
				release: () => {},
				close: () => { events.push('upload'); },
			}),
			lifecycle: () => fail('lifecycle', {
				state: () => 'starting' as const,
				setState: () => {},
				isAcceptingNewWork: () => true,
				requestStarted: () => {},
				requestFinished: () => {},
				inFlight: () => 0,
				waitForDrain: async () => 'drained' as const,
				close: () => { events.push('lifecycle'); },
			}),
			protectedDownloads: () => fail('protectedDownloads', {
				start: () => {},
				close: () => { events.push('protected'); },
			} as unknown as ReturnType<typeof createProtectedDownloadLimiter>),
			routes: () => fail('routes', emptyRoutes),
		};

		let received: unknown;
		try {
			await createProductionBackendContext(testConfig, {
				persistence: createScriptedBackendPersistence(),
				factories,
				resources: {
					uploadLifecycle: ownedTestUploadLifecycleResource(),
					settings: {
						value: settings.store,
						ownership: 'owned',
						start: settings.start,
						close: settings.close,
					},
				},
			});
		} catch (error) {
			received = error;
		}
		expect(received).toBe(original);
		expect(events).toEqual(expected);
	});

	it('does no DB, S3, timer, or maintenance work before explicit startup', async () => {
		const events: string[] = [];
		const settings = settingsHarness('context', events);
		const basePersistence = createScriptedBackendPersistence();
		const databaseCheck = vi.fn(async () => true);
		const purgeExpired = vi.fn(async () => 0);
		const persistence = createScriptedBackendPersistence({
			databaseHealth: { check: databaseCheck },
			authRepository: {
				...basePersistence.authRepository,
				purgeExpired,
			},
		});
		const s3 = fakeS3('context', events);
		const scheduler = schedulerHarness();
		const context = await createProductionBackendContext(testConfig, {
			persistence,
			routes: emptyRoutes,
			factories: { scheduler: () => scheduler.scheduler },
			resources: {
				uploadLifecycle: ownedTestUploadLifecycleResource(),
				logger: { value: testLogger, ownership: 'borrowed' },
				settings: {
					value: settings.store,
					ownership: 'borrowed',
				},
				s3: { value: s3, ownership: 'borrowed' },
			},
		});

		expect(databaseCheck).not.toHaveBeenCalled();
		expect(purgeExpired).not.toHaveBeenCalled();
		expect(settings.start).not.toHaveBeenCalled();
		expect(s3.send).not.toHaveBeenCalled();
		expect(scheduler.scheduler.every).not.toHaveBeenCalled();
		const app = await buildApp({ context });
		expect(databaseCheck).not.toHaveBeenCalled();
		expect(purgeExpired).not.toHaveBeenCalled();
		expect(s3.send).not.toHaveBeenCalled();
		expect(scheduler.scheduler.every).not.toHaveBeenCalled();

		await context.start();
		expect(scheduler.scheduler.every).toHaveBeenCalledTimes(4);
		await app.close();
		expect(events).toEqual([]);
	});

	it('composes, starts, isolates, and closes two complete production route graphs', async () => {
		const events: string[] = [];
		const aScheduler = schedulerHarness();
		const bScheduler = schedulerHarness();
		const aSettings = settingsHarness('a-full', events, 1000);
		const bSettings = settingsHarness('b-full', events, 2000);
		const aFindBannedIps = vi.fn(async () => []);
		const bFindBannedIps = vi.fn(async () => []);
		const aS3 = fakeS3('a-full', events);
		const bS3 = fakeS3('b-full', events);
		const aStorage = { ...storage, head: vi.fn(async () => null) };
		const bStorage = { ...storage, head: vi.fn(async () => null) };
		const aVerify: GoogleTokenVerifier['verify'] = vi.fn(async () => undefined);
		const bVerify: GoogleTokenVerifier['verify'] = vi.fn(async () => undefined);
		let aId = 0;
		let bId = 0;
		const create = (
			label: 'a' | 'b',
			s3: S3Client,
			objectStorage: ObjectStorage,
			scheduler: Scheduler,
			verify: GoogleTokenVerifier['verify'],
			nextId: () => string,
			settings: ReturnType<typeof settingsHarness>,
			findBannedIps: () => Promise<{ ip: string }[]>,
		) => createProductionBackendContext({
			...testConfig,
			NODE_ENV: 'production',
			DEV_AUTH_ENABLED: true,
			UPLOAD_MAX_CONCURRENT: 1,
			API_PUBLIC_URL: `https://${label}.api.test`,
			WEB_PUBLIC_URL: `https://${label}.web.test`,
			PUBLIC_ASSET_BASE_URL: `https://${label}.assets.test`,
			S3_BUCKET_PUBLIC: `${label}-public`,
			S3_BUCKET_PROTECTED: `${label}-protected`,
		}, {
			persistence: (() => {
				const base = createScriptedBackendPersistence();
				return createScriptedBackendPersistence({
					assetsRepository: {
						...base.assetsRepository,
						findAllBannedIps: findBannedIps,
					},
				});
			})(),
			resources: {
				uploadLifecycle: ownedTestUploadLifecycleResource(),
				logger: { value: testLogger, ownership: 'borrowed' },
				clock: {
					value: { now: () => new Date('2026-08-10T00:00:00.000Z') },
					ownership: 'borrowed',
				},
				ids: { value: { next: nextId }, ownership: 'borrowed' },
				scheduler: { value: scheduler, ownership: 'borrowed' },
				fileSystem: { value: fileSystem, ownership: 'borrowed' },
				googleTokens: { value: { verify }, ownership: 'borrowed' },
				settings: {
					value: settings.store,
					ownership: 'owned',
					start: settings.start,
					close: settings.close,
				},
				s3: {
					value: s3,
					ownership: 'owned',
					close: () => s3.destroy(),
				},
				storage: {
					value: objectStorage,
					ownership: 'owned',
					close: () => {},
				},
			},
		});

		const interval = vi.spyOn(globalThis, 'setInterval');
		const [a, b] = await Promise.all([
			create(
				'a',
				aS3,
				aStorage,
				aScheduler.scheduler,
				aVerify,
				() => `a-request-${++aId}`,
				aSettings,
				aFindBannedIps,
			),
			create(
				'b',
				bS3,
				bStorage,
				bScheduler.scheduler,
				bVerify,
				() => `b-request-${++bId}`,
				bSettings,
				bFindBannedIps,
			),
		]);
		const [appA, appB] = await Promise.all([
			buildApp({ context: a }),
			buildApp({ context: b }),
		]);

		for (const route of routeRuntimeContractsFor({ includeDevAuth: false })) {
			const url = route.url === '*' ? '/*' : route.url;
			expect(appA.hasRoute({ method: route.method, url }), `${route.method} ${route.url}`).toBe(true);
			expect(appB.hasRoute({ method: route.method, url }), `${route.method} ${route.url}`).toBe(true);
		}
		expect(aSettings.start).not.toHaveBeenCalled();
		expect(aFindBannedIps).not.toHaveBeenCalled();
		expect(aS3.send).not.toHaveBeenCalled();
		expect(aStorage.head).not.toHaveBeenCalled();
		expect(aScheduler.scheduler.every).not.toHaveBeenCalled();
		expect(interval).not.toHaveBeenCalled();

		a.lifecycle.requestStarted();
		expect(a.lifecycle.inFlight()).toBe(1);
		expect(b.lifecycle.inFlight()).toBe(0);
		a.lifecycle.requestFinished();
		a.uploadLimiter.acquire();
		expect(() => a.uploadLimiter.acquire()).toThrow();
		expect(() => b.uploadLimiter.acquire()).not.toThrow();
		a.protectedDownloads.addBan('10.0.0.15');
		expect(a.protectedDownloads.isBanned('10.0.0.15')).toBe(true);
		expect(b.protectedDownloads.isBanned('10.0.0.15')).toBe(false);

		await Promise.all([a.start(), b.start()]);
		expect(aSettings.start).toHaveBeenCalledOnce();
		expect(bSettings.start).toHaveBeenCalledOnce();
		await expect(a.settings.get()).resolves.toMatchObject({ maxGameFileMb: 1000 });
		await expect(b.settings.get()).resolves.toMatchObject({ maxGameFileMb: 2000 });
		expect(aFindBannedIps).toHaveBeenCalledOnce();
		expect(bFindBannedIps).toHaveBeenCalledOnce();
		expect(aScheduler.tasks).toHaveLength(4);
		expect(bScheduler.tasks).toHaveLength(4);

		await appA.close();
		await a.close();
		expect(aScheduler.tasks.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true);
		expect(bScheduler.tasks.every(({ cancel }) => cancel.mock.calls.length === 0)).toBe(true);
		expect(aS3.destroy).toHaveBeenCalledOnce();
		expect(aSettings.close).toHaveBeenCalledOnce();
		expect(bS3.destroy).not.toHaveBeenCalled();
		expect(bSettings.close).not.toHaveBeenCalled();
		const healthB = await appB.inject({ method: 'GET', url: '/api/health' });
		expect(healthB.statusCode, healthB.body).toBe(200);
		expect(healthB.headers['x-request-id']).toMatch(/^b-request-\d+$/);
		expect(bVerify).not.toHaveBeenCalled();
		expect(aVerify).not.toHaveBeenCalled();

		await appB.close();
		expect(bS3.destroy).toHaveBeenCalledOnce();
		expect(bSettings.close).toHaveBeenCalledOnce();
		interval.mockRestore();
	});

	it('closes owned storage and settings resources once when explicit startup fails after timers begin', async () => {
		const events: string[] = [];
		const original = new Error('second maintenance timer failed');
		let calls = 0;
		const cancel = vi.fn();
		const scheduler: Scheduler = {
			every: vi.fn(() => {
				calls++;
				if (calls === 3) throw original;
				return { cancel };
			}),
			delay: async () => {},
		};
		const settings = settingsHarness('failed', events);
		const s3 = fakeS3('failed', events);
		const context = await createProductionBackendContext(testConfig, {
			persistence: createScriptedBackendPersistence(),
			routes: emptyRoutes,
			factories: { scheduler: () => scheduler },
			resources: {
				uploadLifecycle: ownedTestUploadLifecycleResource(),
				logger: { value: testLogger, ownership: 'borrowed' },
				settings: {
					value: settings.store,
					ownership: 'owned',
					start: settings.start,
					close: settings.close,
				},
				s3: { value: s3, ownership: 'owned', close: () => s3.destroy() },
			},
		});

		await expect(context.start()).rejects.toBe(original);
		await expect(context.close()).resolves.toBeUndefined();
		expect(cancel).toHaveBeenCalledTimes(2);
		expect(events).toEqual(['failed:settings', 'failed:s3']);
	});

	it('serializes close with a deferred start and never starts a later resource', async () => {
		const events: string[] = [];
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => { release = resolve; });
		let enteredStart!: () => void;
		const entered = new Promise<void>((resolve) => { enteredStart = resolve; });
		const firstClose = vi.fn(() => { events.push('first:close'); });
		const settings = settingsHarness('race', events);
		const s3 = fakeS3('race', events);
		const context = await createProductionBackendContext(testConfig, {
			persistence: createScriptedBackendPersistence(),
			routes: emptyRoutes,
			resources: {
				uploadLifecycle: ownedTestUploadLifecycleResource(),
				logger: { value: testLogger, ownership: 'borrowed' },
				settings: {
					value: settings.store,
					ownership: 'borrowed',
				},
				s3: { value: s3, ownership: 'borrowed' },
				protectedDownloads: {
					value: createProtectedDownloadLimiter(),
					ownership: 'owned',
					start: () => {
						enteredStart();
						return barrier;
					},
					close: firstClose,
				},
			},
		});

		const starting = context.start();
		await entered;
		const closing = context.close();
		release();
		await expect(starting).rejects.toThrow('aborted by close');
		await closing;
		await context.close();
		expect(firstClose).toHaveBeenCalledOnce();
		expect(events[0]).toBe('first:close');
	});
});
