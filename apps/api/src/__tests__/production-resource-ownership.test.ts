import { Readable, Writable } from 'node:stream';
import type { FastifyPluginAsync } from 'fastify';
import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { Env } from '../config/env.js';
import type {
	AppLogger,
	FileSystem,
	GoogleTokenVerifier,
	ObjectStorage,
	Scheduler,
} from '../application/ports.js';
import {
	createMaintenanceSchedule,
	createProductionBackendContext,
	type BackendRoutes,
	type ProductionResourceFactories,
} from '../backend-context.js';
import { buildApp } from '../app.js';
import { createProtectedDownloadLimiter } from '../shared/protected-download-limiter.js';
import { routeRuntimeContractsFor } from '../shared/http-route-schemas.js';
import { defaultTestEnv } from './helpers/app-mocks.js';

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
	rename: async () => {},
	remove: async () => {},
	readRange: async () => Buffer.alloc(0),
	createReadStream: () => Readable.from([]),
	createWriteStream: () => new Writable({ write(_chunk, _encoding, done) { done(); } }),
};

const storage: ObjectStorage = {
	upload: async () => {},
	presign: async () => 'https://storage.test/object',
	delete: async () => {},
	head: async () => null,
	readRange: async () => Buffer.alloc(0),
	stream: async () => null,
	listKeys: async () => [],
	createMultipart: async () => 'upload-id',
	uploadPart: async () => 'etag',
	completeMultipart: async () => {},
	abortMultipart: async () => {},
};

function fakePrisma(label: string, events: string[], maxGameFileMb = 5120): PrismaClient {
	return {
		$disconnect: vi.fn(async () => { events.push(label ? `${label}:prisma` : 'prisma'); }),
		$queryRaw: vi.fn(async () => [{ ok: 1 }]),
		authSession: {
			findUnique: vi.fn(async () => null),
			update: vi.fn(async () => ({})),
			deleteMany: vi.fn(async () => ({ count: 0 })),
		},
		gameUploadSession: {
			findMany: vi.fn(async () => []),
		},
		bannedIp: {
			findMany: vi.fn(async () => []),
		},
		siteSetting: {
			upsert: vi.fn(async (args: { create?: { maxGameFileMb?: number }; update?: { maxGameFileMb?: number } }) => ({
				maxGameFileMb: args.update?.maxGameFileMb ?? args.create?.maxGameFileMb ?? maxGameFileMb,
				maxChunkSizeMb: 10,
			})),
		},
		orphanObject: {
			upsert: vi.fn(async () => ({})),
			findMany: vi.fn(async () => []),
			update: vi.fn(async () => ({})),
		},
	} as unknown as PrismaClient;
}

function fakeS3(label: string, events: string[]): S3Client {
	return {
		destroy: vi.fn(() => { events.push(label ? `${label}:s3` : 's3'); }),
		send: vi.fn(),
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
			const prisma = fakePrisma(label, events, setting);
			const s3 = fakeS3(label, events);
			return createProductionBackendContext(config, {
				routes: emptyRoutes,
				factories: { scheduler: () => scheduler },
				resources: {
					logger: { value: borrowedLogger, ownership: 'borrowed' },
					prisma: {
						value: prisma,
						ownership: 'owned',
						close: () => prisma.$disconnect(),
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
		a.exportProgress.start(2025, 1);
		expect(a.exportProgress.get()).toMatchObject({ year: 2025 });
		expect(b.exportProgress.get()).toBeNull();
		await a.settings.update({ maxGameFileMb: 1500 });
		await expect(a.settings.get()).resolves.toMatchObject({ maxGameFileMb: 1500 });
		await expect(b.settings.get()).resolves.toMatchObject({ maxGameFileMb: 2000 });

		await a.start();
		await b.start();
		expect(aScheduler.tasks).toHaveLength(4);
		expect(bScheduler.tasks).toHaveLength(4);
		await a.close();
		await a.close();

		expect(events).toEqual(['a:s3', 'a:prisma']);
		expect(aScheduler.tasks.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true);
		expect(bScheduler.tasks.every(({ cancel }) => cancel.mock.calls.length === 0)).toBe(true);
		expect(() => b.protectedDownloads.check('10.0.0.2')).not.toThrow();
		expect(b.exportProgress.get()).toBeNull();
		expect(borrowedLogger.close).not.toHaveBeenCalled();
		expect(a.resourceOwnership).toContainEqual({ name: 'logger', ownership: 'borrowed' });
		expect(a.resourceOwnership).toContainEqual({ name: 'prisma', ownership: 'owned' });
		await b.close();
		expect(events).toEqual(['a:s3', 'a:prisma', 'b:s3', 'b:prisma']);
	});

	it.each([
		['s3', ['prisma']],
		['settings', ['s3', 'prisma']],
		['lifecycle', ['upload', 'settings', 's3', 'prisma']],
		['exportProgress', ['protected', 'lifecycle', 'upload', 'settings', 's3', 'prisma']],
		['routes', ['export', 'protected', 'lifecycle', 'upload', 'settings', 's3', 'prisma']],
	] as const)('preserves the %s construction error and closes prior resources in reverse', async (failure, expected) => {
		const events: string[] = [];
		const original = new Error(`failure:${failure}`);
		const fail = <T>(name: string, value: T): T => {
			if (name === failure) throw original;
			return value;
		};
		const prisma = fakePrisma('', events);
		const s3 = fakeS3('', events);
		const factories: Partial<ProductionResourceFactories> = {
			logger: () => fail('logger', testLogger),
			clock: () => fail('clock', { now: () => new Date(0) }),
			ids: () => fail('ids', { next: () => 'id' }),
			scheduler: () => fail('scheduler', schedulerHarness().scheduler),
			fileSystem: () => fail('fileSystem', fileSystem),
			googleTokens: () => fail('googleTokens', { verify: async () => undefined }),
			prisma: () => fail('prisma', prisma),
			s3: () => fail('s3', s3),
			storage: () => fail('storage', storage),
			settings: () => fail('settings', {
				get: async () => ({ maxGameFileMb: 1, maxChunkSizeMb: 1 }),
				update: async () => ({ maxGameFileMb: 1, maxChunkSizeMb: 1 }),
				invalidate: () => {},
				close: () => { events.push('settings'); },
			}),
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
			exportProgress: () => fail('exportProgress', {
				start: () => {},
				get: () => null,
				update: () => {},
				finish: () => {},
				close: () => { events.push('export'); },
			}),
			routes: () => fail('routes', emptyRoutes),
		};

		let received: unknown;
		try {
			await createProductionBackendContext(testConfig, { factories });
		} catch (error) {
			received = error;
		}
		expect(received).toBe(original);
		expect(events).toEqual(expected);
	});

	it('does no DB, S3, timer, or maintenance work before explicit startup', async () => {
		const events: string[] = [];
		const prisma = fakePrisma('context', events);
		const s3 = fakeS3('context', events);
		const scheduler = schedulerHarness();
		const context = await createProductionBackendContext(testConfig, {
			routes: emptyRoutes,
			factories: { scheduler: () => scheduler.scheduler },
			resources: {
				logger: { value: testLogger, ownership: 'borrowed' },
				prisma: { value: prisma, ownership: 'borrowed' },
				s3: { value: s3, ownership: 'borrowed' },
			},
		});

		expect(prisma.$queryRaw).not.toHaveBeenCalled();
		expect(prisma.authSession.deleteMany).not.toHaveBeenCalled();
		expect(s3.send).not.toHaveBeenCalled();
		expect(scheduler.scheduler.every).not.toHaveBeenCalled();
		const app = await buildApp({ context });
		expect(prisma.$queryRaw).not.toHaveBeenCalled();
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
		const aPrisma = fakePrisma('a-full', events, 1000);
		const bPrisma = fakePrisma('b-full', events, 2000);
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
			prisma: PrismaClient,
			s3: S3Client,
			objectStorage: ObjectStorage,
			scheduler: Scheduler,
			verify: GoogleTokenVerifier['verify'],
			nextId: () => string,
		) => createProductionBackendContext({
			...testConfig,
			NODE_ENV: 'production',
			DEV_AUTH_ENABLED: true,
			UPLOAD_MAX_CONCURRENT: 1,
			API_PUBLIC_URL: `https://${label}.api.test`,
			WEB_PUBLIC_URL: `https://${label}.web.test`,
			S3_BUCKET_PUBLIC: `${label}-public`,
			S3_BUCKET_PROTECTED: `${label}-protected`,
		}, {
			resources: {
				logger: { value: testLogger, ownership: 'borrowed' },
				clock: {
					value: { now: () => new Date('2026-08-10T00:00:00.000Z') },
					ownership: 'borrowed',
				},
				ids: { value: { next: nextId }, ownership: 'borrowed' },
				scheduler: { value: scheduler, ownership: 'borrowed' },
				fileSystem: { value: fileSystem, ownership: 'borrowed' },
				googleTokens: { value: { verify }, ownership: 'borrowed' },
				prisma: {
					value: prisma,
					ownership: 'owned',
					close: () => prisma.$disconnect(),
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
				aPrisma,
				aS3,
				aStorage,
				aScheduler.scheduler,
				aVerify,
				() => `a-request-${++aId}`,
			),
			create(
				'b',
				bPrisma,
				bS3,
				bStorage,
				bScheduler.scheduler,
				bVerify,
				() => `b-request-${++bId}`,
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
		expect(routeRuntimeContractsFor({ includeDevAuth: false })).toHaveLength(55);
		expect(aPrisma.siteSetting.upsert).not.toHaveBeenCalled();
		expect(aPrisma.bannedIp.findMany).not.toHaveBeenCalled();
		expect(aPrisma.gameUploadSession.findMany).not.toHaveBeenCalled();
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
		a.exportProgress.start(2026, 1);
		expect(a.exportProgress.get()).toMatchObject({ year: 2026 });
		expect(b.exportProgress.get()).toBeNull();

		await Promise.all([a.start(), b.start()]);
		expect(aPrisma.siteSetting.upsert).toHaveBeenCalledOnce();
		expect(bPrisma.siteSetting.upsert).toHaveBeenCalledOnce();
		await expect(a.settings.get()).resolves.toMatchObject({ maxGameFileMb: 1000 });
		await expect(b.settings.get()).resolves.toMatchObject({ maxGameFileMb: 2000 });
		expect(aPrisma.bannedIp.findMany).toHaveBeenCalledOnce();
		expect(bPrisma.bannedIp.findMany).toHaveBeenCalledOnce();
		expect(aPrisma.gameUploadSession.findMany).toHaveBeenCalledTimes(2);
		expect(bPrisma.gameUploadSession.findMany).toHaveBeenCalledTimes(2);
		expect(aScheduler.tasks).toHaveLength(4);
		expect(bScheduler.tasks).toHaveLength(4);

		await appA.close();
		await a.close();
		expect(aScheduler.tasks.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true);
		expect(bScheduler.tasks.every(({ cancel }) => cancel.mock.calls.length === 0)).toBe(true);
		expect(aS3.destroy).toHaveBeenCalledOnce();
		expect(aPrisma.$disconnect).toHaveBeenCalledOnce();
		expect(bS3.destroy).not.toHaveBeenCalled();
		expect(bPrisma.$disconnect).not.toHaveBeenCalled();
		const healthB = await appB.inject({ method: 'GET', url: '/api/health' });
		expect(healthB.statusCode, healthB.body).toBe(200);
		expect(healthB.headers['x-request-id']).toBe('b-request-1');
		expect(bVerify).not.toHaveBeenCalled();
		expect(aVerify).not.toHaveBeenCalled();

		await appB.close();
		expect(bS3.destroy).toHaveBeenCalledOnce();
		expect(bPrisma.$disconnect).toHaveBeenCalledOnce();
		interval.mockRestore();
	});

	it('closes S3 and Prisma once when explicit startup fails after timers begin', async () => {
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
		const prisma = fakePrisma('failed', events);
		const s3 = fakeS3('failed', events);
		const context = await createProductionBackendContext(testConfig, {
			routes: emptyRoutes,
			factories: { scheduler: () => scheduler },
			resources: {
				logger: { value: testLogger, ownership: 'borrowed' },
				prisma: {
					value: prisma,
					ownership: 'owned',
					close: () => prisma.$disconnect(),
				},
				s3: { value: s3, ownership: 'owned', close: () => s3.destroy() },
			},
		});

		await expect(context.start()).rejects.toBe(original);
		await expect(context.close()).resolves.toBeUndefined();
		expect(cancel).toHaveBeenCalledTimes(2);
		expect(events).toEqual(['failed:s3', 'failed:prisma']);
	});

	it('serializes close with a deferred start and never starts a later resource', async () => {
		const events: string[] = [];
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => { release = resolve; });
		let enteredStart!: () => void;
		const entered = new Promise<void>((resolve) => { enteredStart = resolve; });
		const firstClose = vi.fn(() => { events.push('first:close'); });
		const laterStart = vi.fn();
		const laterClose = vi.fn(() => { events.push('later:close'); });
		const prisma = fakePrisma('race', events);
		const s3 = fakeS3('race', events);
		const context = await createProductionBackendContext(testConfig, {
			routes: emptyRoutes,
			resources: {
				logger: { value: testLogger, ownership: 'borrowed' },
				prisma: { value: prisma, ownership: 'borrowed' },
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
				exportProgress: {
					value: {
						start: () => {}, get: () => null, update: () => {}, finish: () => {}, close: () => {},
					},
					ownership: 'owned',
					start: laterStart,
					close: laterClose,
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
		expect(laterStart).not.toHaveBeenCalled();
		expect(firstClose).toHaveBeenCalledOnce();
		expect(laterClose).toHaveBeenCalledOnce();
		expect(events.slice(0, 2)).toEqual(['later:close', 'first:close']);
	});
});
