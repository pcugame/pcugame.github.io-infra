import Fastify, { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import type { S3Client } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppLogger, ObjectStorage, Scheduler, SettingsStore } from '../application/ports.js';
import type { BackendRoutes } from '../backend-context.js';
import type { Env } from '../config/env.js';
import { createProductionBackendContext } from '../backend-context.js';
import { createAssetsBannedProductionGraph } from '../modules/assets/composition.js';
import { createProjectAccessService } from '../modules/admin/project-access.service.js';
import { createProtectedDownloadLimiter } from '../shared/protected-download-limiter.js';
import { defaultTestEnv } from './helpers/app-mocks.js';
import {
	createTestUploadLifecycleRuntime,
	ownedTestUploadLifecycleResource,
} from './helpers/upload-lifecycle.js';
import { createScriptedBackendPersistence } from './helpers/backend-persistence.js';

const emptyRoute: FastifyPluginAsync = async () => {};
const testConfig: Env = {
	...defaultTestEnv,
	LOG_LEVEL: 'info',
	GOOGLE_CLIENT_IDS: [...defaultTestEnv.GOOGLE_CLIENT_IDS],
	CORS_ALLOWED_ORIGINS: [...defaultTestEnv.CORS_ALLOWED_ORIGINS],
};
const testLogger: AppLogger = {
	child: () => testLogger,
	trace: vi.fn(),
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	fatal: vi.fn(),
};
const settings: SettingsStore = {
	get: async () => ({ maxGameFileMb: 5120, maxChunkSizeMb: 10 }),
	update: async () => ({ maxGameFileMb: 5120, maxChunkSizeMb: 10 }),
	invalidate: () => {},
};

function schedulerHarness() {
	const tasks: Array<{ cancel: ReturnType<typeof vi.fn> }> = [];
	const scheduler: Scheduler = {
		every: vi.fn(() => {
			const task = { cancel: vi.fn() };
			tasks.push(task);
			return task;
		}),
		delay: vi.fn(async () => {}),
	};
	return { scheduler, tasks };
}

function storageHarness() {
	const calls = {
		presign: vi.fn(async (bucket: string, key: string) => `https://storage.test/${bucket}/${key}`),
		delete: vi.fn(async () => {}),
		listKeys: vi.fn(async () => [] as string[]),
	};
	const storage: ObjectStorage = {
		upload: vi.fn(),
		presign: calls.presign,
		delete: calls.delete,
		head: vi.fn(async () => null),
		readRange: vi.fn(async () => Buffer.alloc(0)),
		stream: vi.fn(async () => null),
		listKeys: calls.listKeys,
		createMultipart: vi.fn(async () => 'upload-id'),
		uploadPart: vi.fn(async () => 'etag'),
		completeMultipart: vi.fn(),
		abortMultipart: vi.fn(),
		listParts: vi.fn(async () => []),
		listMultipartUploads: vi.fn(async () => []),
	};
	return { storage, calls };
}

function portHarness(initialBans: string[] = []) {
	let bans = initialBans.map((ip, index) => ({
		id: index + 1,
		ip,
		reason: 'existing ban',
		createdAt: new Date('2026-07-22T00:00:00.000Z'),
	}));
	const calls = {
		assetFindFirst: vi.fn(),
		bannedFindMany: vi.fn(async () => bans.map(({ ip }) => ({ ip }))),
		bannedList: vi.fn(async () => [...bans]),
		bannedFindById: vi.fn(async (id: number) => bans.find((row) => row.id === id) ?? null),
		bannedDelete: vi.fn(async (id: number) => {
			const record = bans.find((row) => row.id === id);
			bans = bans.filter((row) => row.id !== id);
			return record;
		}),
		bannedUpsert: vi.fn(async (ip: string, reason: string) => {
			const existing = bans.find((row) => row.ip === ip);
			if (existing) return existing;
			const record = {
				id: bans.length + 1,
				ip,
				reason,
				createdAt: new Date('2026-07-22T00:00:00.000Z'),
			};
			bans.push(record);
			return record;
		}),
	};
	const projectAccessRepository = {
		findProject: vi.fn(async () => ({
			id: 7,
			exhibitionId: 1,
			creatorId: 1,
			status: 'PUBLISHED',
		})),
		isLinkedMember: vi.fn(async () => false),
	};
	return {
		calls,
		assetsRepository: {
			findAssetByStorageKey: calls.assetFindFirst,
			upsertBannedIp: calls.bannedUpsert,
			findAssetByIdWithProject: vi.fn(async () => null),
			claimAssetForDeletion: vi.fn(async () => null),
			completeAssetDeletion: vi.fn(async () => undefined),
			findAllBannedIps: calls.bannedFindMany,
		},
		bannedIpRepository: {
			findAllBannedIps: calls.bannedList,
			findBannedIpById: calls.bannedFindById,
			deleteBannedIp: calls.bannedDelete,
		},
		projectAccessRepository,
		projectAccess: createProjectAccessService(projectAccessRepository),
	};
}

function protectedAsset() {
	return {
		kind: 'GAME',
		project: {
			creatorId: 1,
			title: 'Context Game',
			status: 'PUBLISHED',
			members: [],
		},
	};
}

async function routeApp(plugin: FastifyPluginAsync, prefix: string, asAdmin = false) {
	const app = Fastify();
	app.setErrorHandler((error, _request, reply) => {
		const failure = error as { statusCode?: number; code?: string };
		reply.status(failure.statusCode ?? 500).send({ code: failure.code });
	});
	if (asAdmin) {
		app.addHook('preHandler', async (request) => {
			request.currentUser = {
				id: 1,
				googleSub: 'admin',
				email: 'admin@g.pcu.ac.kr',
				name: 'Admin',
				role: 'ADMIN',
			};
		});
	}
	await app.register(plugin, { prefix });
	await app.ready();
	return app;
}

function graphHarness(initialBans: string[] = [], maxHits = 30) {
	const ports = portHarness(initialBans);
	const storage = storageHarness();
	const scheduler = schedulerHarness();
	const limiter = createProtectedDownloadLimiter({
		maxHits,
		clock: { now: () => new Date('2026-07-22T00:00:00.000Z') },
		scheduler: scheduler.scheduler,
	});
	const uploadLifecycle = createTestUploadLifecycleRuntime();
	const graph = createAssetsBannedProductionGraph({
		config: testConfig,
		assetsRepository: ports.assetsRepository,
		bannedIpRepository: ports.bannedIpRepository,
		projectAccess: ports.projectAccess,
		storage: storage.storage,
		downloadLimiter: limiter,
		logger: testLogger,
		clock: { now: () => new Date('2026-07-22T00:00:00.000Z') },
		uploadLifecycle,
	});
	return {
		storage: storage.storage,
		calls: { ...ports.calls, ...storage.calls },
		scheduler,
		limiter,
		graph,
		uploadLifecycle,
	};
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
	await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('assets/banned-IP production vertical slice', () => {
	it('imports, creates factories, and registers both route prefixes with zero DB/S3/timer work', async () => {
		const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
		try {
			await Promise.all([
				import('../modules/assets/index.js'),
				import('../modules/admin/banned-ip/index.js'),
			]);
			const harness = graphHarness();
			const assetsApp = await routeApp(harness.graph.assetsController, '/api');
			const adminApp = await routeApp(harness.graph.bannedIpController, '/api/admin', true);
			apps.push(assetsApp, adminApp);

			expect(harness.calls.assetFindFirst).not.toHaveBeenCalled();
			expect(harness.calls.bannedFindMany).not.toHaveBeenCalled();
			expect(harness.calls.presign).not.toHaveBeenCalled();
			expect(harness.calls.delete).not.toHaveBeenCalled();
			expect(harness.scheduler.scheduler.every).not.toHaveBeenCalled();
			expect(setIntervalSpy).not.toHaveBeenCalled();
		} finally {
			setIntervalSpy.mockRestore();
		}
	});

	it('fails closed before warmup and keeps a failed warmup fatal and idempotent', async () => {
		const harness = graphHarness();
		harness.calls.assetFindFirst.mockResolvedValue(protectedAsset());
		const app = await routeApp(harness.graph.assetsController, '/api');
		apps.push(app);

		const beforeWarmup = await app.inject({
			method: 'GET',
			url: '/api/assets/protected/game.zip',
			remoteAddress: '203.0.113.10',
		});
		expect(beforeWarmup.statusCode).toBe(503);
		expect(beforeWarmup.json()).toEqual({ code: 'BANNED_IP_CACHE_UNAVAILABLE' });
		expect(harness.calls.presign).not.toHaveBeenCalled();

		const failure = new Error('database unavailable');
		harness.calls.bannedFindMany.mockRejectedValue(failure);
		await expect(harness.graph.warmup.start()).rejects.toBe(failure);
		harness.calls.bannedFindMany.mockResolvedValue([{ ip: '203.0.113.10' }]);
		await expect(harness.graph.warmup.start()).rejects.toBe(failure);
		expect(harness.calls.bannedFindMany).toHaveBeenCalledOnce();
		expect(harness.limiter._bannedSize()).toBe(0);
	});

	it('blocks recovered DB bans and preserves protected redirect, Range, and rate-limit wiring', async () => {
		const recovered = graphHarness(['203.0.113.10'], 1);
		recovered.calls.assetFindFirst.mockResolvedValue(protectedAsset());
		await recovered.graph.warmup.start();
		const app = await routeApp(recovered.graph.assetsController, '/api');
		apps.push(app);

		const banned = await app.inject({
			method: 'GET',
			url: '/api/assets/protected/game.zip',
			remoteAddress: '203.0.113.10',
		});
		expect(banned.statusCode).toBe(403);
		expect(banned.json()).toEqual({ code: 'IP_BANNED' });

		const first = await app.inject({
			method: 'GET',
			url: '/api/assets/protected/game.zip',
			remoteAddress: '203.0.113.20',
			headers: { range: 'bytes=0-7' },
		});
		expect(first.statusCode).toBe(302);
		expect(first.headers.location).toBe('https://storage.test/pcu-protected/game.zip');
		expect(recovered.calls.presign).toHaveBeenCalledWith(
			'pcu-protected',
			'game.zip',
			expect.objectContaining({ responseContentDisposition: expect.any(String) }),
		);

		const exceeded = await app.inject({
			method: 'GET',
			url: '/api/assets/protected/game.zip',
			remoteAddress: '203.0.113.20',
		});
		expect(exceeded.statusCode).toBe(403);
		expect(recovered.calls.bannedUpsert).toHaveBeenCalledWith(
			'203.0.113.20',
			expect.any(String),
		);
	});

	it('keeps context A/B cache and buckets independent, scopes admin mutation, and closes only A', async () => {
		async function createContext(label: string) {
			const ports = portHarness(['203.0.113.30']);
			const storage = storageHarness();
			const scheduler = schedulerHarness();
			const s3 = { destroy: vi.fn(), send: vi.fn() } as unknown as S3Client;
			const context = await createProductionBackendContext(testConfig, {
				persistence: createScriptedBackendPersistence({
					assetsRepository: ports.assetsRepository,
					bannedIpRepository: ports.bannedIpRepository,
					projectAccessRepository: ports.projectAccessRepository,
				}),
				factories: {
					scheduler: () => scheduler.scheduler,
					routes: (_config, graph): BackendRoutes => ({
						auth: emptyRoute,
						devAuth: emptyRoute,
						public: emptyRoute,
						admin: graph.bannedIpController,
						me: emptyRoute,
						assets: graph.assetsController,
					}),
				},
				resources: {
					uploadLifecycle: ownedTestUploadLifecycleResource(),
					logger: { value: testLogger, ownership: 'borrowed' },
					s3: { value: s3, ownership: 'borrowed' },
					storage: { value: storage.storage, ownership: 'borrowed' },
					settings: { value: settings, ownership: 'borrowed' },
				},
			});
			return { label, context, ports, scheduler };
		}

		const a = await createContext('a');
		const b = await createContext('b');
		await Promise.all([a.context.start(), b.context.start()]);
		expect(a.context.protectedDownloads.isBanned('203.0.113.30')).toBe(true);
		expect(b.context.protectedDownloads.isBanned('203.0.113.30')).toBe(true);

		expect(a.context.protectedDownloads.check('203.0.113.40')).toBe('ok');
		expect(a.context.protectedDownloads._bucketSize()).toBe(1);
		expect(b.context.protectedDownloads._bucketSize()).toBe(0);

		const adminA = await routeApp(a.context.routes.admin, '/api/admin', true);
		apps.push(adminA);
		const unban = await adminA.inject({ method: 'DELETE', url: '/api/admin/banned-ips/1' });
		expect(unban.statusCode).toBe(204);
		expect(a.ports.calls.bannedDelete).toHaveBeenCalledOnce();
		expect(b.ports.calls.bannedDelete).not.toHaveBeenCalled();
		expect(a.context.protectedDownloads.isBanned('203.0.113.30')).toBe(false);
		expect(b.context.protectedDownloads.isBanned('203.0.113.30')).toBe(true);

		await a.context.close();
		expect(a.scheduler.tasks.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true);
		expect(b.scheduler.tasks.every(({ cancel }) => cancel.mock.calls.length === 0)).toBe(true);
		expect(() => b.context.protectedDownloads.check('203.0.113.50')).not.toThrow();
		await b.context.close();
	});

	it('aborts context startup on warmup failure and accepts recovered bans only in a fresh context', async () => {
		async function createWith(ports: ReturnType<typeof portHarness>, scheduler: ReturnType<typeof schedulerHarness>) {
			const storage = storageHarness();
			return createProductionBackendContext(testConfig, {
				persistence: createScriptedBackendPersistence({
					assetsRepository: ports.assetsRepository,
					bannedIpRepository: ports.bannedIpRepository,
					projectAccessRepository: ports.projectAccessRepository,
				}),
				factories: {
					scheduler: () => scheduler.scheduler,
					routes: (_config, graph): BackendRoutes => ({
						auth: emptyRoute,
						devAuth: emptyRoute,
						public: emptyRoute,
						admin: graph.bannedIpController,
						me: emptyRoute,
						assets: graph.assetsController,
					}),
				},
				resources: {
					uploadLifecycle: ownedTestUploadLifecycleResource(),
					logger: { value: testLogger, ownership: 'borrowed' },
					s3: {
						value: { destroy: vi.fn(), send: vi.fn() } as unknown as S3Client,
						ownership: 'borrowed',
					},
					storage: { value: storage.storage, ownership: 'borrowed' },
					settings: { value: settings, ownership: 'borrowed' },
				},
			});
		}

		const failedPorts = portHarness();
		const failure = new Error('banned IP query failed');
		failedPorts.calls.bannedFindMany.mockRejectedValue(failure);
		const failedScheduler = schedulerHarness();
		const failed = await createWith(failedPorts, failedScheduler);
		await expect(failed.start()).rejects.toBe(failure);
		await expect(failed.start()).rejects.toThrow('BackendContext is closed');
		expect(failedPorts.calls.bannedFindMany).toHaveBeenCalledOnce();
		expect(failedScheduler.tasks).toHaveLength(1);
		expect(failedScheduler.tasks[0]!.cancel).toHaveBeenCalledOnce();

		const recoveredPorts = portHarness(['203.0.113.60']);
		const recovered = await createWith(recoveredPorts, schedulerHarness());
		await recovered.start();
		expect(recovered.protectedDownloads.isBanned('203.0.113.60')).toBe(true);
		await recovered.close();
	});
});
