import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createBannedIpRepository } from '../modules/admin/banned-ip/repository.js';
import { createAssetsRepository } from '../modules/assets/repository.js';
import { createAssetsBannedProductionGraph } from '../modules/assets/composition.js';
import { createProjectAccessService } from '../modules/admin/project-access.service.js';
import { createProtectedDownloadLimiter } from '../shared/protected-download-limiter.js';
import { registerRouteSchemas } from '../shared/http-route-schemas.js';
import { registerAuth } from '../plugins/auth.js';
import { defaultTestEnv } from './helpers/app-mocks.js';
import { createTestUploadLifecycleRuntime } from './helpers/upload-lifecycle.js';
import type { AppLogger, AuthSessionRecord } from '../application/ports.js';

const logger: AppLogger = {
	child: () => logger, trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
};
const now = new Date('2026-09-28T01:00:00Z');
const headers = (session = 'admin') => ({ cookie: `sid=${session}`, origin: 'http://localhost:5173' });
const asset = {
	id: 42, projectId: 1, kind: 'GAME', status: 'READY',
	representations: [{ role: 'ORIGINAL', bucket: 'protected', objectKey: 'game.zip', state: 'READY' }],
	project: { creatorId: 1, title: 'Game', status: 'PUBLISHED', members: [] },
};

describe.runIf(process.env['RUN_POSTGRES_INTEGRATION'] === 'true')('IP bans: PostgreSQL migration and authenticated HTTP contracts', () => {
	let control: PrismaClient;
	let client: PrismaClient;
	const schema = `ip_bans_${randomUUID().replaceAll('-', '')}`;
	let migrated: Array<{ source: string; disabled_at: Date | null; reason: string }>;
	const apps: FastifyInstance[] = [];

	beforeAll(async () => {
		const url = new URL(process.env['DATABASE_URL']!);
		control = createPrismaClientForDatabase(url.toString());
		await control.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
		const migration = await readFile(new URL('../../prisma/migrations/20260928000000_manual_ip_ranges/migration.sql', import.meta.url), 'utf8');
		await control.$executeRawUnsafe(`SET search_path TO "${schema}";
			CREATE TABLE banned_ips (id SERIAL PRIMARY KEY, ip TEXT UNIQUE NOT NULL, reason TEXT NOT NULL DEFAULT '', created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
			INSERT INTO banned_ips (ip, reason) VALUES
			('192.0.2.1', 'Rate limit exceeded (game download)'),
			('192.0.2.2', 'Rate limit exceeded (protected asset download)'),
			('192.0.2.3', 'Protected download IP abuse ceiling exceeded'),
			('192.0.2.4', 'Rate limit exceeded'),
			('192.0.2.5', 'Protected download IP abuse ceiling exceeded ');
			${migration}`);
		migrated = await control.$queryRawUnsafe(`SELECT source, disabled_at, reason FROM "${schema}".banned_ips ORDER BY id`);
		url.searchParams.set('schema', schema);
		client = createPrismaClientForDatabase(url.toString());
	});
	beforeEach(async () => { await client.bannedIp.deleteMany(); });
	afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
	afterAll(async () => {
		await client?.$disconnect();
		await control?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
		await control?.$disconnect();
	});

	async function harness(autoEnabled = false, maxIpHits = 3000) {
		const limiter = createProtectedDownloadLimiter({ autoIpBanEnabled: autoEnabled, maxIpHits, clock: { now: () => now } });
		const assetsRepository = createAssetsRepository(client);
		const banRepository = createBannedIpRepository(client);
		const graph = createAssetsBannedProductionGraph({
			config: { ...defaultTestEnv, DOWNLOAD_AUTO_IP_BAN_ENABLED: autoEnabled },
			assetsRepository: { ...assetsRepository, findAssetByIdForDownload: vi.fn(async () => asset) },
			bannedIpRepository: banRepository,
			projectAccess: createProjectAccessService({ findProject: vi.fn(), isLinkedMember: vi.fn() }),
			protectedDownloadPresigner: { presign: vi.fn(async () => 'https://download.test/signed') },
			downloadLimiter: limiter, logger, clock: { now: () => now },
			uploadLifecycle: createTestUploadLifecycleRuntime(),
		});
		await graph.warmup.start();
		const app = Fastify();
		apps.push(app);
		app.addHook('onClose', async () => limiter.close());
		app.setValidatorCompiler(validatorCompiler);
		app.setSerializerCompiler(serializerCompiler);
		registerRouteSchemas(app);
		app.setErrorHandler((error, _request, reply) => {
			const err = error as { statusCode?: number; code?: string; message?: string; validation?: unknown };
			const status = err.statusCode ?? 500;
			reply.status(status).send({ ok: false, error: { code: err.validation ? 'VALIDATION_ERROR' : status >= 500 ? 'INTERNAL_ERROR' : err.code ?? 'ERROR', message: status >= 500 ? 'Internal server error' : err.message ?? 'Error' } });
		});
		await app.register(cookie);
		await registerAuth(app, {
			config: defaultTestEnv, clock: { now: () => now }, logger,
			sessions: {
				find: async (id): Promise<AuthSessionRecord | null> => {
					if (!['admin', 'operator', 'user', 'other'].includes(id)) return null;
					return { id, lastSeenAt: now, expiresAt: new Date(now.getTime() + 60_000), user: {
						id: id === 'other' ? 2 : 1, googleSub: id, email: `${id}@g.pcu.ac.kr`, name: id,
						role: id === 'admin' ? 'ADMIN' : id === 'operator' ? 'OPERATOR' : 'USER', studentId: null,
					} };
				}, touch: vi.fn(), delete: vi.fn(),
			},
		});
		await app.register(graph.bannedIpController, { prefix: '/api/admin' });
		await app.register(graph.assetsController, { prefix: '/api' });
		await app.ready();
		const download = (session = 'user', ip = '192.0.2.9') => app.inject({ url: '/api/assets/42/download?variant=original', headers: headers(session), remoteAddress: ip });
		const post = (ip: string, session = 'admin') => app.inject({ method: 'POST', url: '/api/admin/banned-ips', headers: headers(session), payload: { ip, reason: 'Manual test block' } });
		return { app, limiter, post, download, banRepository };
	}

	it('classifies and disables only the three exact historical automatic reasons', () => {
		expect(migrated.slice(0, 3).map((row) => row.source)).toEqual(['AUTO', 'AUTO', 'AUTO']);
		for (const row of migrated.slice(0, 3)) expect(row.disabled_at).toBeInstanceOf(Date);
		for (const row of migrated.slice(3)) expect(row).toMatchObject({ source: 'LEGACY', disabled_at: null });
	});

	it('serializes empty/populated lists, creates normalized bans, enforces only downloads, and persists unban/restart', async () => {
		const h = await harness();
		const empty = await h.app.inject({ url: '/api/admin/banned-ips', headers: headers() });
		expect(empty.statusCode).toBe(200);
		expect(empty.json()).toEqual({ ok: true, data: { items: [] } });
		const created = await h.post('::ffff:192.0.2.199/120', 'operator');
		expect(created.statusCode).toBe(201);
		const row = created.json().data;
		expect(row).toMatchObject({ ip: '192.0.2.0/24', source: 'MANUAL', active: true, disabledAt: null });
		expect(typeof row.createdAt).toBe('string');
		expect((await h.post('192.0.2.99/24')).statusCode).toBe(409);
		expect((await h.download()).statusCode).toBe(403);
		expect((await h.app.inject({ url: '/api/admin/banned-ips', remoteAddress: '192.0.2.9', headers: headers() })).json().data.items).toEqual([row]);
		expect((await h.download('user', '192.0.3.1')).statusCode).toBe(302);
		expect((await (await harness()).download()).statusCode).toBe(403);
		const removed = await h.app.inject({ method: 'DELETE', url: `/api/admin/banned-ips/${row.id}`, headers: headers() });
		expect(removed.statusCode).toBe(204);
		expect((await h.download()).statusCode).toBe(302);
		const restarted = await harness();
		expect((await restarted.download()).statusCode).toBe(302);
		const history = (await restarted.app.inject({ url: '/api/admin/banned-ips', headers: headers() })).json().data.items[0];
		expect(history).toMatchObject({ active: false, source: 'MANUAL' });
		expect(typeof history.disabledAt).toBe('string');
		expect((await restarted.post('192.0.2.0/24')).json().data).toMatchObject({ id: row.id, active: true, source: 'MANUAL', disabledAt: null });
	});

	it('rejects unauthenticated and USER writes and malformed targets at authenticated HTTP boundary', async () => {
		const h = await harness();
		for (const method of ['GET', 'POST', 'DELETE'] as const) {
			const opts = { method, url: method === 'DELETE' ? '/api/admin/banned-ips/1' : '/api/admin/banned-ips', ...(method === 'POST' ? { payload: { ip: '192.0.2.1', reason: 'test' } } : {}) };
			expect((await h.app.inject(opts)).statusCode).toBe(401);
			expect((await h.app.inject({ ...opts, headers: headers('user') })).statusCode).toBe(403);
		}
		for (const ip of ['localhost', '192.0.2.1:80', '192.0.2.1/33', '[::1]:80', '::/129']) expect((await h.post(ip)).statusCode).toBe(400);
		expect((await h.app.inject({ method: 'POST', url: '/api/admin/banned-ips', headers: headers(), payload: { ip: '192.0.2.1', reason: '' } })).statusCode).toBe(400);
		expect(await client.bannedIp.count()).toBe(0);
	});

	it('makes 3,001 authenticated requests OFF without DB/cache IP bans and allows another principal on the same IP', async () => {
		const h = await harness(false);
		for (let index = 0; index < 3001; index++) expect((await h.download()).statusCode).toBe(index < 30 ? 302 : 429);
		expect(await client.bannedIp.count()).toBe(0);
		expect(h.limiter._bannedSize()).toBe(0);
		expect(h.limiter._ipBucketSize()).toBe(0);
		expect((await h.download('other', '::ffff:192.0.2.9')).statusCode).toBe(302);
	});

	it('retains ON ceiling behavior, but never reapplies a deactivated automatic record', async () => {
		const h = await harness(true);
		for (let index = 0; index < 3000; index++) expect((await h.download()).statusCode).toBe(index < 30 ? 302 : 429);
		expect((await h.download()).statusCode).toBe(403);
		expect(await client.bannedIp.findUnique({ where: { ip: '192.0.2.9' } })).toMatchObject({ source: 'AUTO', disabledAt: null });
		expect((await h.download('other')).statusCode).toBe(403);
		await client.bannedIp.updateMany({ data: { disabledAt: now } });
		const restarted = await harness(true);
		for (let index = 0; index < 3002; index++) expect((await restarted.download()).statusCode).toBe(index < 30 ? 302 : 429);
		expect(restarted.limiter._bannedSize()).toBe(0);
		expect((await client.bannedIp.findUniqueOrThrow({ where: { ip: '192.0.2.9' } })).disabledAt).toEqual(now);
	});

	it('does not recreate a deactivated mapped automatic address under its canonical IPv4 spelling', async () => {
		await client.bannedIp.create({ data: { ip: '::ffff:192.0.2.9', source: 'AUTO', disabledAt: now } });
		const h = await harness(true, 1);
		expect((await h.download()).statusCode).toBe(302);
		expect((await h.download()).statusCode).toBe(429);
		expect((await h.download()).statusCode).toBe(429);
		expect(h.limiter._bannedSize()).toBe(0);
		expect(await client.bannedIp.count()).toBe(1);
	});

	it('filters startup by source and flag, converts inactive AUTO to MANUAL, handles overlaps and concurrent duplicate registration', async () => {
		await client.bannedIp.createMany({ data: [
			{ ip: '192.0.2.9', source: 'AUTO' },
			{ ip: '192.0.3.0/24', source: 'LEGACY' },
			{ ip: '2001:db8::/64', source: 'MANUAL' },
			{ ip: '192.0.4.0/24', source: 'AUTO', disabledAt: now },
		] });
		const h = await harness(false);
		expect((await h.download()).statusCode).toBe(302);
		expect((await h.download('user', '192.0.3.9')).statusCode).toBe(403);
		expect((await h.download('user', '2001:db8::ffff')).statusCode).toBe(403);
		expect((await h.download('user', '2001:db8:0:1::')).statusCode).toBe(302);
		expect((await h.post('192.0.2.9')).json().data).toMatchObject({ source: 'MANUAL', active: true });
		const duplicates = await Promise.all([h.post('192.0.5.7/24'), h.post('192.0.5.88/24')]);
		expect(duplicates.map((r) => r.statusCode).sort()).toEqual([201, 409]);
		const overlap = await h.post('192.0.5.128/25');
		expect(overlap.statusCode).toBe(201);
		const wider = duplicates.find((r) => r.statusCode === 201)!.json().data;
		await h.app.inject({ method: 'DELETE', url: `/api/admin/banned-ips/${wider.id}`, headers: headers() });
		expect((await h.download('user', '192.0.5.127')).statusCode).toBe(302);
		expect((await h.download('user', '192.0.5.128')).statusCode).toBe(403);
	});

	it('rejects equivalent legacy targets and converts disabled noncanonical legacy records', async () => {
		const legacy = await client.bannedIp.create({ data: { ip: '2001:0db8:0000:0000:0000:0000:0000:0001', source: 'LEGACY' } });
		const h = await harness();
		expect((await h.post('2001:db8::1/128')).statusCode).toBe(409);
		await h.app.inject({ method: 'DELETE', url: `/api/admin/banned-ips/${legacy.id}`, headers: headers() });
		expect((await h.post('2001:db8::1')).json().data).toMatchObject({ id: legacy.id, source: 'MANUAL', ip: '2001:db8::1', active: true });
	});

	it('reactivates the canonical inactive row when inactive mapped aliases also exist', async () => {
		const row = await client.bannedIp.create({ data: { ip: '192.0.2.1', source: 'AUTO', disabledAt: now } });
		await client.bannedIp.create({ data: { ip: '::ffff:192.0.2.1', source: 'AUTO', disabledAt: now } });
		const h = await harness();
		expect((await h.post('::ffff:192.0.2.1')).json().data).toMatchObject({ id: row.id, source: 'MANUAL', active: true });
		expect((await client.bannedIp.findUniqueOrThrow({ where: { ip: '::ffff:192.0.2.1' } })).disabledAt).toEqual(now);
	});

	it('leaves the cache unchanged on registration/unban DB failures ', async () => {
		const h = await harness();
		const spy = vi.spyOn(h.banRepository, 'createManualBan').mockRejectedValueOnce(new Error('DB unavailable'));
		expect((await h.post('192.0.2.9')).statusCode).toBe(500);
		expect(h.limiter._bannedSize()).toBe(0);
		spy.mockRestore();
		const row = (await h.post('192.0.2.9')).json().data;
		vi.spyOn(h.banRepository, 'deleteBannedIp').mockRejectedValueOnce(new Error('DB unavailable'));
		expect((await h.app.inject({ method: 'DELETE', url: `/api/admin/banned-ips/${row.id}`, headers: headers() })).statusCode).toBe(500);
		expect((await h.download()).statusCode).toBe(403);
	});
});
