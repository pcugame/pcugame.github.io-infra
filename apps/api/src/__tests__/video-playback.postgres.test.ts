import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createPlaybackWorker } from '../modules/video/playback.worker.js';
import { createBoundedCommandRunner } from '../modules/video/command-runner.js';
import { createFfmpegVideoOperations } from '../modules/video/ffmpeg-operations.js';
import { DEFAULT_VIDEO_LIMITS } from '../modules/video/policy.js';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod';
import { PublicProjectDetailResponseSchema } from '@pcu/contracts';
import { createPublicController } from '../modules/public/controller.js';
import { createPublicService } from '../modules/public/service.js';
import { createPublicRepository } from '../modules/public/repository.js';
import { createFileAccessController } from '../modules/file-access/controller.js';
import { createAssetsController } from '../modules/assets/controller.js';
import { createAssetsService } from '../modules/assets/service.js';
import { createAssetsRepository } from '../modules/assets/repository.js';
import { defaultTestEnv } from './helpers/app-mocks.js';
import { registerAuth } from '../plugins/auth.js';
import { createAuthRepository } from '../modules/auth/repository.js';
import { registerRouteSchemas } from '../shared/http-route-schemas.js';
import { AppError } from '../shared/errors.js';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createIsolatedMigratedDatabase } from './helpers/isolated-migrated-database.js';
import { createPlaybackRepository, sourceVersion } from '../modules/video/playback.repository.js';
import { createFileAccessRepository } from '../modules/file-access/repository.js';
import { createObjectReferenceResolver } from '../modules/orphan/reference-resolver.js';

describe.runIf(process.env['RUN_POSTGRES_INTEGRATION'] === 'true')('versioned video playback PostgreSQL fences', () => {
	let database: Awaited<ReturnType<typeof createIsolatedMigratedDatabase>>;
	let db: ReturnType<typeof database.createClient>;
	let repo: ReturnType<typeof createPlaybackRepository>;
	let projectId: number;
	beforeAll(async () => {
		database = await createIsolatedMigratedDatabase(process.env['DATABASE_URL']!);
		db = database.createClient(); repo = createPlaybackRepository(db);
		await db.storageBucket.create({ data: { bucket: 'protected', visibility: 'PROTECTED' } });
		const owner = await db.user.create({ data: { googleSub: randomUUID(), name: 'owner', email: `${randomUUID()}@test.dev` } });
		const year = await db.exhibition.create({ data: { year: 2099, title: 'Playback' } });
		projectId = (await db.project.create({ data: { creatorId: owner.id, exhibitionId: year.id, slug: randomUUID(), title: 'Legacy video', status: 'PUBLISHED', publicationStatus: 'PUBLIC' } })).id;
	}, 60_000);
	afterAll(async () => { await database?.close(); });
	const asset = () => db.asset.create({
		data: {
			projectId, kind: 'VIDEO', status: 'READY', representations: {
				create: [
					{ role: 'ORIGINAL', state: 'READY', bucket: 'protected', objectKey: `source/${randomUUID()}`, mimeType: 'video/mp4', sizeBytes: 20n, checksumAlgorithm: 'SHA256', checksum: 'original-checksum' },
					{ role: 'PLAYBACK', state: 'READY', bucket: 'protected', objectKey: `old/${randomUUID()}`, mimeType: 'video/mp4', sizeBytes: 10n },
				]
			}
		}, include: { representations: true }
	});
	async function generated(job: NonNullable<Awaited<ReturnType<typeof repo.claim>>>, withQuality = false) {
		await repo.bindSource(job.id, job.leaseToken!, 'source-checksum');
		const outputs = [];
		for(const profile of ['native', 'cap60', 'cap30', ...(withQuality ? ['native@720p', 'cap60@720p', 'cap30@720p'] : [])]) {
			const row = await repo.prepare(job.id, job.leaseToken!, profile, 'protected', `job/${job.id}/${job.leaseToken}/${profile}.mp4`);
			outputs.push({ id: row.id, checksum: 'output-checksum', sizeBytes: 15n, frameRate: profile.startsWith('native') ? 120 : profile.startsWith('cap60') ? 60 : 30, width: profile.includes('@') ? 1280 : 1920, height: profile.includes('@') ? 720 : 1080 });
		}
		return outputs;
	}
	it('enqueues legacy videos once, atomically activates all profiles, retains old requests for 24 hours, preserves original', async () => {
		const a = await asset(); const source = a.representations.find(r => r.role === 'ORIGINAL')!;
		expect(await db.assetUploadSession.count({ where: { resultAssetId: a.id } })).toBe(0);
		const raced = await Promise.all([repo.enqueue(a.id), repo.enqueue(a.id)]);
		expect(raced.sort()).toEqual([false, true]);
		const job = (await repo.claim())!;
		const outputs = await generated(job);
		await repo.complete(job.id, job.leaseToken!, outputs);
		expect(await db.assetRepresentation.findUnique({ where: { id: source.id } })).toEqual(source);
		const native = await db.assetRepresentation.findUniqueOrThrow({ where: { asset_representation_asset_role: { assetId: a.id, role: 'PLAYBACK' } } });
		expect(native.objectKey).toContain('/native.mp4');
		const jobs = await db.videoPlaybackJob.findMany({ where: { assetId: a.id, active: true }, include: { renditions: true } });
		expect(jobs[0]!.renditions.filter(r => r.expiresAt === null)).toHaveLength(3);
		const legacy = jobs[0]!.renditions.find(r => r.profile === 'legacy')!;
		expect(legacy.expiresAt!.getTime() - Date.now()).toBeGreaterThan(23.9 * 60 * 60_000);
		expect(await createFileAccessRepository(db).findRepresentation(legacy.bucket, legacy.objectKey)).toBeTruthy();
		const references = createObjectReferenceResolver(db, { publicBucket: 'public', protectedBucket: 'protected' }, { error() { } });
		expect(await references.isReferenced({ bucket: 'protected', key: legacy.objectKey, targetKind: 'EXACT' })).toBe(true);
		await db.videoPlaybackRendition.update({ where: { id: legacy.id }, data: { expiresAt: new Date(0) } });
		await repo.cleanup();
		expect(await createFileAccessRepository(db).findRepresentation(legacy.bucket, legacy.objectKey)).toBeNull();
		expect(await db.orphanObject.findFirst({ where: { storageKey: legacy.objectKey } })).toBeTruthy();
		expect(await db.orphanObject.findFirst({ where: { storageKey: source.objectKey } })).toBeNull();
	});
	it('expires leases, fences late attempts, rejects changed sources, and retains healthy playback on failure', async () => {
		const a = await asset(); const source = a.representations.find(r => r.role === 'ORIGINAL')!;
		expect(await repo.enqueue(a.id, 'wrong-version')).toBe(false);
		expect(await repo.enqueue(a.id, sourceVersion(source), 'source-checksum')).toBe(true);
		const first = (await repo.claim())!;
		const stale = await generated(first);
		await db.videoPlaybackJob.update({ where: { id: first.id }, data: { leaseUntil: new Date(0) } });
		expect(await repo.renew(first.id, first.leaseToken!)).toEqual({ count: 0 });
		const resumed = (await repo.claim())!;
		expect(resumed.id).toBe(first.id); expect(resumed.leaseToken).not.toBe(first.leaseToken);
		await expect(repo.complete(first.id, first.leaseToken!, stale)).rejects.toThrow('lease lost');
		const outputs = await generated(resumed);
		await db.assetRepresentation.update({ where: { id: source.id }, data: { objectKey: 'changed-source' } });
		await expect(repo.complete(resumed.id, resumed.leaseToken!, outputs)).rejects.toThrow('SOURCE_CHANGED');
		await repo.fail(resumed.id, resumed.leaseToken!, 'SOURCE_CHANGED');
		expect((await db.assetRepresentation.findUnique({ where: { asset_representation_asset_role: { assetId: a.id, role: 'PLAYBACK' } } }))?.objectKey).toBe(a.representations.find(r => r.role === 'PLAYBACK')!.objectKey);
		await repo.cleanup();
		expect(await db.videoPlaybackRendition.count({ where: { jobId: resumed.id, state: 'PENDING' } })).toBe(0);
		expect(await repo.enqueue(a.id)).toBe(true);
		const retry = (await repo.claim())!;
		await expect(repo.bindSource(retry.id, retry.leaseToken!, 'first')).resolves.toBeUndefined();
		await expect(repo.bindSource(retry.id, retry.leaseToken!, 'replacement')).rejects.toThrow('SOURCE_CHANGED');
		await repo.fail(retry.id, retry.leaseToken!, 'test failure');
	});
	it('keeps durable output ownership after hard asset deletion for later cleanup', async () => {
		const a = await asset(); await repo.enqueue(a.id);
		const job = (await repo.claim())!; const outputs = await generated(job);
		await repo.complete(job.id, job.leaseToken!, outputs);
		const rows = await db.videoPlaybackRendition.findMany({ where: { jobId: job.id } });
		await db.asset.delete({ where: { id: a.id } });
		expect((await db.videoPlaybackJob.findUnique({ where: { id: job.id } }))?.assetId).toBeNull();
		await repo.cleanup();
		for(const r of rows) expect(await db.orphanObject.findFirst({ where: { storageKey: r.objectKey } })).toBeTruthy();
	});
	it('serializes legacy/empty/multiple renditions through authenticated HTTP and checks profile grants, HEAD, Range, renewal and revocation', async () => {
		const a = await asset();
		const p = await db.project.findUniqueOrThrow({ where: { id: projectId } });
		const viewer = await db.user.create({ data: { googleSub: randomUUID(), email: `${randomUUID()}@test.dev` } });
		const sid = (await db.authSession.create({ data: { userId: viewer.id, expiresAt: new Date(Date.now() + 3600000) } })).id;
		const config = {
			...defaultTestEnv, LOG_LEVEL: 'error' as const, GOOGLE_CLIENT_IDS: [...defaultTestEnv.GOOGLE_CLIENT_IDS], CORS_ALLOWED_ORIGINS: [...defaultTestEnv.CORS_ALLOWED_ORIGINS], API_PUBLIC_URL: 'http://api.test', PUBLIC_ASSET_ORIGIN: 'http://public.test',
			S3_BUCKET_PUBLIC: 'public', S3_BUCKET_PROTECTED: 'protected', S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT: 'http://protected.test', FILE_GATEWAY_SECRET: 'video-gateway-secret'
		};
		const app = Fastify(); app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
		await app.register(cookie);
		await registerAuth(app, { config, clock: { now: () => new Date() }, logger: app.log, sessions: createAuthRepository(db) });
		app.setErrorHandler((error, _request, reply) => reply.status(error instanceof AppError ? error.statusCode : (error as { statusCode?: number }).statusCode ?? 500).send({ ok: false, error: { code: 'ERROR', message: error instanceof Error ? error.message : 'error' } }));
		registerRouteSchemas(app);
		const publicService = createPublicService({ apiPublicUrl: config.API_PUBLIC_URL, repository: createPublicRepository(db), publicBucket: 'public' });
		await app.register(createPublicController({ service: publicService }), { prefix: '/api/public' });
		const assetsService = createAssetsService({
			repository: createAssetsRepository(db), downloadLimiter: { add() { }, check: () => 'ok' },
			presign: async (bucket, key) => `http://protected.test/${bucket}/${key}`, wakeDeletionWorker() { }, loadProjectWithAccess: async () => ({}), logger: app.log
		});
		await app.register(createAssetsController({ service: assetsService }), { prefix: '/api' });
		await app.register(createFileAccessController(createFileAccessRepository(db), config, () => new Date(),
			async (bucket, key, options) => `http://protected.test/${bucket}/${key}?method=${options?.method ?? 'GET'}`, async () => ({})), { prefix: '/api' });
		const headers = { cookie: `sid=${sid}`, origin: config.WEB_PUBLIC_URL };
		const detail = () => app.inject({ url: `/api/public/projects/${projectId}`, headers });
		try {
			const legacy = await detail(); expect(legacy.statusCode, legacy.body).toBe(200);
			const old = PublicProjectDetailResponseSchema.parse(legacy.json().data).videos.find(v => v.assetId === a.id)!;
			expect(old.url).toContain('variant=playback'); expect(old.playbacks).toBeUndefined();
			await repo.enqueue(a.id); const job = (await repo.claim())!;
            await expect(repo.prepare(job.id, job.leaseToken!, 'native@480p', 'protected', 'rejected/480p.mp4')).rejects.toThrow();
			await repo.complete(job.id, job.leaseToken!, await generated(job, true));
			const response = await detail(); expect(response.statusCode, response.body).toBe(200);
			const video = PublicProjectDetailResponseSchema.parse(response.json().data).videos.find(v => v.assetId === a.id)!;
			expect(video.playbacks?.map(r => r.frameRate)).toEqual([120, 60, 30, 120, 60, 30]);
            expect(video.playbacks?.map(r => r.quality)).toEqual(['max', 'max', 'max', '720p', '720p', '720p']);
			const grantResponse = await app.inject({ method: 'POST', url: '/api/file-access', headers, payload: { url: video.playbacks![5]!.url } });
			expect(grantResponse.statusCode, grantResponse.body).toBe(200);
			const grant = grantResponse.json().data;
			const gateHeaders = { 'x-pcu-gateway-secret': config.FILE_GATEWAY_SECRET, 'x-pcu-file-kind': 'protected', 'x-pcu-file-uri': new URL(grant.url).pathname };
			const head = await app.inject({ url: '/api/internal/file-access', headers: { ...gateHeaders, 'x-pcu-file-method': 'HEAD' } });
			expect(head.statusCode, head.body).toBe(204); expect(head.headers['x-pcu-object-path']).toContain('cap30@720p.mp4?method=HEAD');
			expect((await app.inject({ url: '/api/internal/file-access', headers: { ...gateHeaders, range: 'bytes=10-20' } })).statusCode).toBe(204);
			const redirect = await app.inject({ url: `/api/assets/${a.id}/download?variant=playback&profile=cap60`, headers });
			expect(redirect.statusCode).toBe(302); expect(redirect.headers.location).toContain('cap60.mp4');
            const lower = await app.inject({ url: `/api/assets/${a.id}/download?variant=playback&profile=cap60&quality=720p`, headers });
            expect(lower.statusCode, lower.body).toBe(302); expect(lower.headers.location).toContain('cap60@720p.mp4');
            expect((await app.inject({ url: `/api/assets/${a.id}/download?variant=playback&quality=480p`, headers })).statusCode).toBe(400);
            expect((await app.inject({ method: 'POST', url: '/api/file-access', headers, payload: { url: `http://api.test/api/assets/${a.id}/download?variant=playback&quality=480p` } })).statusCode).toBe(404);
			expect((await app.inject({ url: `/api/assets/${a.id}/download?variant=playback&profile=invalid`, headers })).statusCode).toBe(400);
			expect((await app.inject({ method: 'POST', url: `/api/file-access/${grant.token}/renew`, headers })).statusCode).toBe(200);
			await db.project.update({ where: { id: projectId }, data: { publicationStatus: 'PRIVATE' } });
			expect((await app.inject({ url: '/api/internal/file-access', headers: gateHeaders })).statusCode).toBe(403);
			expect((await app.inject({ method: 'POST', url: `/api/file-access/${grant.token}/renew`, headers })).statusCode).toBe(403);
			await db.project.update({ where: { id: projectId }, data: { visibility: 'PUBLIC' } });
			const emptyProject = await db.project.create({ data: { creatorId: p.creatorId, exhibitionId: p.exhibitionId, title: 'Empty', slug: randomUUID(), status: 'PUBLISHED', publicationStatus: 'PUBLIC' } });
			const empty = await app.inject({ url: `/api/public/projects/${emptyProject.id}`, headers });
			expect(empty.statusCode, empty.body).toBe(200); expect(PublicProjectDetailResponseSchema.parse(empty.json().data).videos).toEqual([]);
		} finally { await app.close(); }
	});

	it.runIf(process.env['RUN_FFMPEG_TESTS'] === 'true')('processes preserved original bytes end to end with real FFmpeg and PostgreSQL, retaining playback on an auxiliary upload failure', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'video-job-integration-'));
		try {
			const runner = createBoundedCommandRunner();
			const path = join(dir, 'source.mp4');
			await runner.run({ file: 'ffmpeg', args: ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x960:rate=120000/1001:duration=0.8', '-c:v', 'libx264', '-pix_fmt', 'yuv444p', path], timeoutMs: 30000, maxOutputBytes: 65536 });
			const bytes = await readFile(path); const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
			const a = await asset(); const original = a.representations.find(r => r.role === 'ORIGINAL')!;
			const stored = await db.assetRepresentation.update({ where: { id: original.id }, data: { sizeBytes: BigInt(bytes.length), checksum: sha(bytes), etag: 'source-etag' } });
			const objects = new Map([[original.objectKey, bytes]]);
			let failAuxiliary = false;
			const worker = createPlaybackWorker({
				repository: repo, operations: createFfmpegVideoOperations(runner, DEFAULT_VIDEO_LIMITS), limits: DEFAULT_VIDEO_LIMITS,
				tempRoot: dir, tempDiskBudgetBytes: 10_000_000, logger: { error() { } }, storage: {
					stream: async (_bucket, key) => ({ body: Readable.from(objects.get(key)!), size: objects.get(key)!.length, etag: key === original.objectKey ? 'source-etag' : 'output-etag' }),
					head: async (_bucket, key) => objects.has(key) ? { size: objects.get(key)!.length, checksumSha256: sha(objects.get(key)!), etag: key === original.objectKey ? 'source-etag' : 'output-etag' } : null,
					upload: async input => { if(failAuxiliary && input.key.includes('cap30')) throw new Error('Injected upload failure'); const chunks = []; for await(const chunk of input.body) chunks.push(Buffer.from(chunk)); objects.set(input.key, Buffer.concat(chunks)); },
				}
			});
			await repo.enqueue(a.id, sourceVersion(stored), sha(bytes));
			const processed = await worker.runPass();
			expect(processed, JSON.stringify(await db.videoPlaybackJob.findMany({ where: { assetId: a.id } }))).toMatchObject({ claimed: 1, ready: 1, rejected: 0 });
			const active = await db.videoPlaybackJob.findFirstOrThrow({ where: { assetId: a.id, active: true }, include: { renditions: true } });
			expect(active.renditions.filter(r => r.expiresAt === null).map(r => Math.round(r.frameRate! * 100) / 100).sort((a, b) => b - a)).toEqual([119.88, 119.88, 59.94, 59.94, 29.97, 29.97]);
            expect(active.renditions.filter(r => r.expiresAt === null).map(r => r.height).sort()).toEqual([720, 720, 720, 960, 960, 960]);
			const previous = await db.assetRepresentation.findUniqueOrThrow({ where: { asset_representation_asset_role: { assetId: a.id, role: 'PLAYBACK' } } });
			failAuxiliary = true; await repo.enqueue(a.id);
			expect(await worker.runPass()).toMatchObject({ claimed: 1, ready: 0, rejected: 1 });
			expect(await db.assetRepresentation.findUnique({ where: { id: previous.id } })).toEqual(previous);
			expect(await db.assetRepresentation.findUnique({ where: { id: original.id } })).toEqual(stored);
			expect(sha(objects.get(original.objectKey)!)).toBe(sha(bytes));
		} finally { await rm(dir, { recursive: true, force: true }); }
	}, 90_000);

});
