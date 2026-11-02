import cookie from '@fastify/cookie';
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod';
import { registerAuth } from '../plugins/auth.js';
import { registerRouteSchemas } from '../shared/http-route-schemas.js';
import { createFileAccessController } from '../modules/file-access/controller.js';
import type { FileAccessRepository } from '../modules/file-access/repository.js';
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
		listKeyPage: vi.fn(async () => ({ keys: [], isTruncated: false })),
		deleteKeys: vi.fn(async (_bucket, keys) => ({ deleted: [...keys], failures: [] })),
	};
	const storage: ObjectStorage = {
		upload: vi.fn(),
		delete: calls.delete,
		head: vi.fn(async () => null),
		readRange: vi.fn(async () => Buffer.alloc(0)),
		stream: vi.fn(async () => null),
		listKeys: calls.listKeys,
		listKeyPage: calls.listKeyPage,
		deleteKeys: calls.deleteKeys,
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
		source: 'LEGACY' as const, disabledAt: null,
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
				source: 'LEGACY' as const, disabledAt: null,
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
			findAssetByIdForDownload: calls.assetFindFirst,
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
			createManualBan: vi.fn(),
		},
		projectAccessRepository,
		projectAccess: createProjectAccessService(projectAccessRepository),
	};
}

function protectedAsset() {
	return {
		id: 1,
		projectId: 7,
		kind: 'GAME',
		status: 'READY',
		representations: [{
			role: 'ORIGINAL',
			bucket: 'pcu-protected',
			objectKey: 'assets/1/original/g1.zip',
			state: 'READY',
		}],
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

function graphHarness(initialBans: string[] = [], maxHits = 30, autoIpBanEnabled = false) {
	const ports = portHarness(initialBans);
	const storage = storageHarness();
	const scheduler = schedulerHarness();
	const limiter = createProtectedDownloadLimiter({
		autoIpBanEnabled,
		maxIpHits: 2,
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
		protectedDownloadPresigner: { presign: storage.calls.presign },
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
			url: '/api/assets/1/download?variant=original',
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

	it('blocks recovered DB bans, preserves protected redirect, and treats ordinary principal excess as temporary', async () => {
		const recovered = graphHarness(['203.0.113.10'], 1);
		recovered.calls.assetFindFirst.mockResolvedValue(protectedAsset());
		await recovered.graph.warmup.start();
		const app = await routeApp(recovered.graph.assetsController, '/api');
		apps.push(app);

		const banned = await app.inject({
			method: 'GET',
			url: '/api/assets/1/download?variant=original',
			remoteAddress: '203.0.113.10',
		});
		expect(banned.statusCode).toBe(403);
		expect(banned.json()).toEqual({ code: 'IP_BANNED' });

		const first = await app.inject({
			method: 'GET',
			url: '/api/assets/1/download?variant=original',
			remoteAddress: '203.0.113.20',
			headers: { range: 'bytes=0-7' },
		});
		expect(first.statusCode).toBe(302);
		expect(first.headers.location).toBe('https://storage.test/pcu-protected/assets/1/original/g1.zip');
		expect(recovered.calls.presign).toHaveBeenCalledWith(
			'pcu-protected',
			'assets/1/original/g1.zip',
			expect.objectContaining({ responseContentDisposition: expect.any(String) }),
		);

		const exceeded = await app.inject({
			method: 'GET',
			url: '/api/assets/1/download?variant=original',
			remoteAddress: '203.0.113.20',
		});
		expect(exceeded.statusCode).toBe(429);
		expect(recovered.calls.bannedUpsert).not.toHaveBeenCalled();
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

		expect(a.context.protectedDownloads.check('203.0.113.40')).toEqual({ status: 'ok' });
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

// Real services, startup gate and limiter; only persistence and storage are scripted.
async function fileGatewayHarness(options: { warm?: boolean; visibility?: 'PUBLIC' | 'PRIVATE' } = {}) {
 const h = graphHarness([], 1, true);
 const config = { ...testConfig, API_PUBLIC_URL: 'http://api.test', PUBLIC_ASSET_ORIGIN: 'http://public.test',
  S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT: 'http://protected.test', S3_BUCKET_PROTECTED: 'pcu-protected',
  S3_BUCKET_PUBLIC: 'pcu-public', SESSION_COOKIE_NAME: 'sid', FILE_GATEWAY_SECRET: 'gateway-test-secret' };
 const asset = { ...protectedAsset(), project: { ...protectedAsset().project,
  visibility: options.visibility ?? 'PUBLIC', exhibition: { visibility: 'PUBLIC' }, currentWebglDeploymentId: null } };
 h.calls.assetFindFirst.mockResolvedValue(asset);
 const actor = { id: 1, role: 'USER' as const, googleSub: 'owner', email: 'owner@test.invalid', name: 'Owner' };
 const time = new Date('2026-07-22T00:00:00.000Z');
 const session = { id: 'owner', user: actor, lastSeenAt: time, expiresAt: new Date(time.getTime() + 3600000) };
 const tokens = new Map<string, { id: string; sessionId: string | null; bucket: string; objectKey: string; deploymentId: string | null; expiresAt: Date }>();
 const representation = { ...asset.representations[0]!, asset };
 const repository = {
  asset: vi.fn(async () => asset),
  findRepresentation: vi.fn(async (bucket: string, key: string) => key === representation.objectKey && ['pcu-protected', 'pcu-public'].includes(bucket) ? representation : null),
  findDeployment: vi.fn(async () => null), deployment: vi.fn(async () => null),
  session: vi.fn(async (id: string) => id === 'owner' ? session : null),
  token: vi.fn(async (id: string) => tokens.get(id) ?? null),
  purgeExpired: vi.fn(async () => undefined), reusable: vi.fn(async () => null), activeCount: vi.fn(async () => tokens.size),
  createToken: vi.fn(async (token: Parameters<FileAccessRepository['createToken']>[0]) => { tokens.set(token.id, token); return token; }),
  renew: vi.fn(async (id: string, expiresAt: Date) => { const token = tokens.get(id)!; token.expiresAt = expiresAt; return token; }),
 } as unknown as FileAccessRepository;
 const presign = vi.fn(async (bucket: string, key: string) => `http://protected.test/${bucket}/${key}?signature=test`);
 const app = Fastify({ trustProxy: false });
 apps.push(app);
 app.addHook('onClose', async () => h.limiter.close());
 app.setValidatorCompiler(validatorCompiler);
 app.setSerializerCompiler(serializerCompiler);
 registerRouteSchemas(app);
 app.setErrorHandler((error, _request, reply) => {
  const failure = error as { statusCode?: number; code?: string; message: string };
  reply.status(failure.statusCode ?? 500).send({ ok: false, error: { code: failure.code ?? 'INTERNAL_ERROR', message: failure.message } });
 });
 await app.register(cookie);
 await registerAuth(app, { config, clock: { now: () => time }, logger: testLogger,
  sessions: { find: repository.session, touch: vi.fn(), delete: vi.fn() } });
 await app.register(h.graph.assetsController, { prefix: '/api' });
 await app.register(createFileAccessController(repository, config, h.graph.assertDownloadIpAllowed,
  () => time, presign, h.graph.authorizeDownload), { prefix: '/api' });
 if (options.warm !== false) await h.graph.warmup.start();
 const ip = '203.0.113.42';
 const legacy = '/pcu-protected/' + representation.objectKey;
 const normal = (headers: Record<string, string> = {}) => app.inject({ url: '/api/assets/1/download', remoteAddress: ip, headers });
 const gateway = (uri = legacy, headers: Record<string, string> = {}, address = ip) => app.inject({
  url: '/api/internal/file-access', remoteAddress: address, headers: {
   'x-pcu-gateway-secret': config.FILE_GATEWAY_SECRET, 'x-pcu-file-kind': 'protected', 'x-pcu-file-uri': uri, ...headers,
  },
 });
 const issue = (authenticated = false) => app.inject({ method: 'POST', url: '/api/file-access', remoteAddress: ip,
  headers: authenticated ? { cookie: 'sid=owner', origin: testConfig.CORS_ALLOWED_ORIGINS[0]! } : {},
  payload: { url: 'http://protected.test' + legacy } });
 return { ...h, app, config, repository, presign, ip, legacy, normal, gateway, issue };
}

describe('gateway download IP policy with the production assets/banned-IP graph', () => {
 it('denies the same banned public file through normal and legacy requests before signing', async () => {
  const h = await fileGatewayHarness();
  h.limiter.addBan('203.0.113.0/24');
  for (const response of [await h.normal(), await h.gateway()]) {
   expect(response.statusCode).toBe(403);
   expect(response.json().error.code).toBe('IP_BANNED');
   expect(response.headers['x-pcu-object-path']).toBeUndefined();
  }
  expect(h.calls.presign).not.toHaveBeenCalled();
  expect(h.presign).not.toHaveBeenCalled();
  expect(h.limiter._bucketSize()).toBe(0);
  expect((await h.gateway(h.legacy, {}, '198.51.100.2')).statusCode).toBe(204);
 });

 it('keeps GET, HEAD, Range and retries out of grant accounting while preserving upstream contracts', async () => {
  const h = await fileGatewayHarness();
  for (let index = 0; index < 5; index++) {
   const method = index % 2 ? 'HEAD' : 'GET';
   const response = await h.gateway(h.legacy, { 'x-pcu-file-method': method, range: 'bytes=0-99' });
   expect(response.statusCode).toBe(204);
   expect(response.headers['x-pcu-object-path']).toBe(h.legacy + '?signature=test');
   expect(response.headers['x-pcu-upstream-host']).toBe('protected.test');
   expect(response.headers['cache-control']).toBe('private, no-store');
   expect(h.presign).toHaveBeenLastCalledWith('pcu-protected', 'assets/1/original/g1.zip',
    { method, responseContentDisposition: expect.stringContaining('attachment;') });
  }
  expect(h.limiter._bucketSize()).toBe(0);
  expect(h.limiter._ipBucketSize()).toBe(0);
  expect((await h.normal()).statusCode).toBe(302);
  expect((await h.normal()).statusCode).toBe(429);
  expect((await h.gateway()).statusCode).toBe(204);
  expect(h.calls.bannedUpsert).not.toHaveBeenCalled();
 });

 it('rechecks a ban added after token issuance and observes removal without consuming another grant', async () => {
  const h = await fileGatewayHarness();
  const issued = await h.issue();
  expect(issued.statusCode).toBe(200);
  const grant = issued.json().data;
  expect(grant.token).toMatch(/^[a-f0-9]{64}$/);
  expect(grant.url).toBe('http://protected.test/file/' + grant.token);
  const uri = new URL(grant.url).pathname;
  expect((await h.gateway(uri)).statusCode).toBe(204);
  h.limiter.addBan(h.ip);
  h.presign.mockClear();
  expect((await h.gateway(uri)).json().error.code).toBe('IP_BANNED');
  expect(h.presign).not.toHaveBeenCalled();
  h.limiter.removeBan(h.ip);
  expect((await h.gateway(uri)).statusCode).toBe(204);
  expect((await h.normal()).statusCode).toBe(429);
 });

 it('keeps private object authorization ahead of IP enforcement and accepts an owner capability', async () => {
  const h = await fileGatewayHarness({ visibility: 'PRIVATE' });
  expect((await h.normal()).statusCode).toBe(401);
  expect((await h.gateway()).statusCode).toBe(403);
  expect((await h.issue()).statusCode).toBe(403);
  const issued = await h.issue(true);
  expect(issued.statusCode).toBe(200);
  const uri = new URL(issued.json().data.url).pathname;
  expect((await h.gateway(uri)).statusCode).toBe(204);
  h.limiter.addBan(h.ip);
  h.presign.mockClear();
  expect((await h.gateway()).json().error.code).toBe('FORBIDDEN');
  expect((await h.gateway(uri)).json().error.code).toBe('IP_BANNED');
  expect(h.presign).not.toHaveBeenCalled();
 });

 it('fails closed before warmup but authenticates the gateway before checking IPs', async () => {
  const h = await fileGatewayHarness({ warm: false });
  expect((await h.gateway(h.legacy, { 'x-pcu-gateway-secret': 'wrong' })).statusCode).toBe(403);
  expect((await h.gateway()).json().error.code).toBe('BANNED_IP_CACHE_UNAVAILABLE');
  expect((await h.normal()).statusCode).toBe(503);
  expect(h.presign).not.toHaveBeenCalled();
  await h.graph.warmup.start();
  expect((await h.gateway()).statusCode).toBe(204);
 });

 it('uses request.ip and leaves public-origin delivery outside protected download limits', async () => {
  const h = await fileGatewayHarness();
  h.limiter.addBan(h.ip);
  expect((await h.gateway(h.legacy, { 'x-forwarded-for': '198.51.100.2', 'x-real-ip': '198.51.100.2' })).json().error.code).toBe('IP_BANNED');
  expect((await h.gateway(h.legacy, { 'x-forwarded-for': h.ip }, '198.51.100.2')).statusCode).toBe(204);
  const publicResponse = await h.gateway('/assets/1/original/g1.zip', { 'x-pcu-file-kind': 'public' });
  expect(publicResponse.statusCode).toBe(204);
  expect(publicResponse.headers['x-pcu-object-path']).toBe('/assets/1/original/g1.zip');
 });
});
