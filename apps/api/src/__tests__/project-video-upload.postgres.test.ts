import { createPlaybackRepository } from '../modules/video/playback.repository.js';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';
import { createAssetUploadRepository } from '../modules/asset-upload/repository.js';
import { createProjectCrudRepository } from '../modules/admin/project/crud.repository.js';
import { createVideoWorkerRepository } from '../modules/video/repository.js';
import type { VerifyingVideoSession } from '../modules/video/ports.js';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod';
import { AdminProjectDetailSchema, VideoRetryResponseSchema } from '@pcu/contracts';
import { registerAuth } from '../plugins/auth.js';
import { validateCsrfOrigin } from '../plugins/csrf.js';
import { createAuthRepository } from '../modules/auth/repository.js';
import { createVideoRetryController } from '../modules/video/retry.controller.js';
import { createVideoRetryService } from '../modules/video/retry.service.js';
import { createVideoRetryRepository } from '../modules/video/retry.repository.js';
import { videoPlaybackObjectKey } from '../modules/video/playback-identity.js';
import { registerRouteSchemas } from '../shared/http-route-schemas.js';
import { AppError } from '../shared/errors.js';
import { createProjectController } from '../modules/admin/project/controller.js';
import { createProjectService } from '../modules/admin/project/service.js';
import { createProjectSerializer } from '../modules/admin/project/serializer.js';
import { createProjectAccessService } from '../modules/admin/project-access.service.js';
import { createProjectAccessRepository } from '../modules/admin/project-access.repository.js';

const enabled = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';
describe.runIf(enabled)('project video upload PostgreSQL transactions', () => {
	const schema = `video_upload_${randomUUID().replaceAll('-', '')}`;
	let control: PrismaClient;
	let prisma: PrismaClient;
	let actorId: number;
	let exhibitionId: number;
	beforeAll(async () => {
		const url = new URL(process.env['DATABASE_URL']!);
		control = createPrismaClientForDatabase(url.toString());
		await control.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
		const root = new URL('../../prisma/migrations/', import.meta.url);
		for (const migration of (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map(({ name }) => name).sort()) {
			const connection = createPrismaClientForDatabase(url.toString());
			try {
				await connection.$executeRawUnsafe(`SET search_path TO "${schema}";\n${await readFile(new URL(`${migration}/migration.sql`, root), 'utf8')}`);
			} finally { await connection.$disconnect(); }
		}
		url.searchParams.set('schema', schema);
		url.searchParams.set('options', `-c search_path=${schema}`);
		prisma = createPrismaClientForDatabase(url.toString());
		await prisma.storageBucket.create({ data: { bucket: 'protected', visibility: 'PROTECTED' } });
		actorId = (await prisma.user.create({ data: { googleSub: schema, email: `${schema}@example.test`, name: 'Video test', role: 'ADMIN' } })).id;
		exhibitionId = (await prisma.exhibition.create({ data: { year: 2099, title: schema } })).id;
	}, 60_000);
	afterAll(async () => {
		await prisma?.$disconnect();
		if (control) {
			await control.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
			await control.$disconnect();
		}
	});

	async function project() {
		return prisma.project.create({ data: { exhibitionId, creatorId: actorId, slug: randomUUID(), title: 'Video test', status: 'PUBLISHED' } });
	}
	async function allocate(projectId: number, item?: { id: string; clientToken: string }, kind: 'VIDEO' | 'GAME' | 'IMAGE' | 'POSTER' = 'VIDEO') {
		const id = randomUUID();
		return createAssetUploadRepository(prisma).createAllocating({
			id, projectId, exhibitionId: null, userId: actorId, kind, originalName: 'video.mp4', declaredMimeType: 'video/mp4', totalBytes: 10n,
			partSizeBytes: 10, totalParts: 1, bucket: 'protected', objectKey: `protected/uploads/${id}/source`, generation: 1,
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'a'.repeat(64), sourceIdentityBlockSizeBytes: 1_048_576,
			sourceIdentityBlockManifest: 'e30=', expiresAt: new Date(Date.now() + 60_000), submissionItemId: item?.id ?? null,
			...(item ? { submissionClientToken: item.clientToken } : {}),
		});
	}
	async function commit(sessionId: string) {
		const session = await prisma.assetUploadSession.update({ where: { id: sessionId }, data: { state: 'VERIFYING', validationLeaseToken: 'lease', validationLeaseUntil: new Date(Date.now() + 60_000) } });
		return createVideoWorkerRepository(prisma).commitVideoOriginalReady({
			session: session as VerifyingVideoSession, token: 'lease', originalMimeType: 'video/mp4', originalSizeBytes: 10n,
			playback: { bucket: 'protected', objectKey: `${session.objectKey}/playback`, mimeType: 'video/mp4' },
		});
	}


    it.each(['GAME', 'IMAGE', 'POSTER'] as const)('%s holds its single active slot through an unresolved create and releases it only on termination', async kind => {
        const p = await project();
        const repository = createAssetUploadRepository(prisma);
        const results = await Promise.allSettled([allocate(p.id, undefined, kind), allocate(p.id, undefined, kind)]);
        const winners = results.filter(result => result.status === 'fulfilled');
        expect(winners).toHaveLength(1);
        expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
        const first = winners[0]!.value;
        expect(await repository.findById(first.id)).toMatchObject({ state: 'ALLOCATING' });
        await expect(allocate(p.id, undefined, kind)).rejects.toThrow();
        expect(await repository.cancel(first.id, actorId)).toMatchObject({ cancelled: true });
        expect(await repository.cancel(first.id, actorId)).toMatchObject({ cancelled: true });
        const second = await allocate(p.id, undefined, kind);
        await prisma.assetUploadSession.update({ where: { id: second.id }, data: { state: 'COMPLETING' } });
        expect(await repository.cancel(second.id, actorId)).toMatchObject({ cancelled: false });
        await expect(allocate(p.id, undefined, kind)).rejects.toThrow();
        await prisma.assetUploadSession.update({ where: { id: second.id }, data: { state: 'READY' } });
        expect(await repository.cancel(second.id, actorId)).toMatchObject({ cancelled: false });
        await expect(allocate(p.id, undefined, kind)).resolves.toMatchObject({ state: 'ALLOCATING' });
    });

	it('serializes racing fifth allocations and counts committed playback assets only once', async () => {
		const p = await project();
		for (let index = 0; index < 4; index++) await commit((await allocate(p.id)).id);
		const outcomes = await Promise.allSettled([allocate(p.id), allocate(p.id)]);
		expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
		const rejected = outcomes.find((result) => result.status === 'rejected');
		expect(rejected?.reason).toMatchObject({ statusCode: 409 });
		const winner = outcomes.find((result) => result.status === 'fulfilled');
		await commit(winner!.value.id);
		expect((await prisma.asset.findMany({ where: { projectId: p.id }, orderBy: { videoSortOrder: 'asc' } })).map(({ videoSortOrder }) => videoSortOrder)).toEqual([0, 1, 2, 3, 4]);
		await expect(allocate(p.id)).rejects.toMatchObject({ statusCode: 409 });
	});

	it('keeps submission slot order on reverse completion and retries', async () => {
		const created = await createProjectCrudRepository(prisma, { publicBucket: 'public', protectedBucket: 'protected' }).createProjectWithAssets({
			exhibitionId, creatorId: actorId, title: 'Submission videos', slug: randomUUID(), status: 'DRAFT', members: [],
			manifest: [0, 1, 2, 3, 4].map((index) => ({ kind: 'VIDEO', slot: `video:${index}`, clientToken: String(index).repeat(32), required: true })),
		});
		const bySlot = new Map<string, string>();
		for (const item of created.submission.items) bySlot.set(item.slot, (await allocate(created.id, item)).id);
		for (const slot of [4, 3, 2, 1, 0]) {
			const sessionId = bySlot.get(`video:${slot}`)!;
			const result = await commit(sessionId);
			expect(await prisma.asset.findUnique({ where: { id: result.assetId } })).toMatchObject({ videoSortOrder: slot });
			expect(await commit(sessionId)).toEqual(result);
		}
		expect(await prisma.asset.count({ where: { projectId: created.id } })).toBe(5);
	});

	it('retries through authenticated HTTP, preserves original bytes, fences racing requests, and exposes processing results', async () => {
		const p = await project();
		const app = Fastify();
		app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
		await app.register(cookie);
		const origin = 'http://localhost:5173';
		const config = { SESSION_COOKIE_NAME: 'sid', SESSION_IDLE_MS: 3600000, SESSION_TOUCH_MIN_INTERVAL_MS: 3600000, COOKIE_SECURE: false, COOKIE_SAME_SITE: 'lax' as const, CORS_ALLOWED_ORIGINS: [origin] };
		await registerAuth(app, { config, clock: { now: () => new Date() }, logger: app.log, sessions: createAuthRepository(prisma) });
		app.addHook('onRequest', async request => validateCsrfOrigin(request.method, request.headers.origin, new Set([origin])));
		app.setErrorHandler((error, _request, reply) => {
			reply.status(error instanceof AppError ? error.statusCode : (error as { statusCode?: number }).statusCode ?? 500)
				.send({ ok: false, error: { code: error instanceof AppError ? error.code : 'ERROR', message: error instanceof Error ? error.message : 'Error' } });
		});
		registerRouteSchemas(app);
		const access = createProjectAccessService(createProjectAccessRepository(prisma));
		const repository = createProjectCrudRepository(prisma);
		const service = createProjectService({ repository,
			resolveExternalLinks: async () => [], serializeProjectDetail: createProjectSerializer('http://localhost:4000').serializeProjectDetail,
			deletionBuckets: { publicBucket: 'public', protectedBucket: 'protected' }, abortMultipart: async () => {}, wakeDeletionWorker() {}, wakeMaintenance() {}, logger: app.log });
		await app.register(createProjectController({ service, access, status: { assertTransition() {}, bulkUpdate: async () => ({ updated: 0 }) } }), { prefix: '/api/admin' });
		await app.register(createVideoRetryController(createVideoRetryService(createVideoRetryRepository(prisma))), { prefix: '/api/admin' });
		async function headers(role: 'USER' | 'ADMIN' | 'OPERATOR') {
			const user = await prisma.user.create({ data: { googleSub: randomUUID(), email: `${randomUUID()}@example.test`, name: role, role } });
			const id = randomUUID();
			await prisma.authSession.create({ data: { id, userId: user.id, expiresAt: new Date(Date.now() + 3600000), lastSeenAt: new Date() } });
			return { cookie: `sid=${id}`, origin };
		}
		const admin = await headers('ADMIN'), operator = await headers('OPERATOR'), student = await headers('USER');
		try {
			const detail = () => app.inject({ method: 'GET', url: `/api/admin/projects/${p.id}`, headers: admin });
			const empty = await detail();
			expect(empty.statusCode, empty.body).toBe(200);
			expect(AdminProjectDetailSchema.parse(empty.json().data).videos).toEqual([]);
			const allocated = await allocate(p.id);
			const session = await prisma.assetUploadSession.update({ where: { id: allocated.id }, data: { state: 'VERIFYING', validationLeaseToken: 'lease', validationLeaseUntil: new Date(Date.now() + 60000) } });
			const worker = createVideoWorkerRepository(prisma);
			const original = await worker.commitVideoOriginalReady({ session: session as VerifyingVideoSession, token: 'lease', originalMimeType: 'video/mp4', originalSizeBytes: 10n,
				playback: { bucket: 'protected', objectKey: videoPlaybackObjectKey({ ...session, projectId: p.id }), mimeType: 'video/mp4' } });
			await worker.commitVideoPlaybackFailed({ session: session as VerifyingVideoSession, token: 'lease', ...original, reason: 'PLAYBACK_FAILED: Generated playback is not browser-safe' });
			const sourceBefore = await prisma.assetRepresentation.findUniqueOrThrow({ where: { id: original.originalRepresentationId } });
			// Repair must not depend on the original uploader retaining upload access.
			const formerUploader = await prisma.user.create({ data: { googleSub: randomUUID(), email: `${randomUUID()}@example.test`, name: 'Former uploader', role: 'USER' } });
			await prisma.assetUploadSession.update({ where: { id: session.id }, data: { userId: formerUploader.id } });
			const url = `/api/admin/projects/${p.id}/videos/${original.assetId}/retry`;
			expect(AdminProjectDetailSchema.parse((await detail()).json().data).videos[0]?.playbackStatus).toBe('FAILED');
			expect((await app.inject({ method: 'POST', url, headers: { origin } })).statusCode).toBe(401);
			expect((await app.inject({ method: 'POST', url, headers: student })).statusCode).toBe(403);
			expect((await app.inject({ method: 'POST', url, headers: { ...admin, origin: 'https://other.test' } })).statusCode).toBe(403);
			expect((await app.inject({ method: 'POST', url: `/api/admin/projects/${p.id + 999999}/videos/${original.assetId}/retry`, headers: admin })).statusCode).toBe(404);
			const raced = await Promise.all([admin, operator].map(headers => app.inject({ method: 'POST', url, headers })));
			expect(raced.map(response => response.statusCode).sort()).toEqual([202, 409]);
			const accepted = raced.find(response => response.statusCode === 202)!;
			expect(VideoRetryResponseSchema.parse(accepted.json().data)).toEqual({ assetId: original.assetId, playbackStatus: 'PENDING' });
			const pending = await detail();
			expect(pending.statusCode, pending.body).toBe(200);
			expect(AdminProjectDetailSchema.parse(pending.json().data).videos[0]).toMatchObject({ playbackStatus: 'FAILED', playbackJob: { status: 'PENDING' } });
			expect(await prisma.assetRepresentation.findUnique({ where: { id: sourceBefore.id } })).toEqual(sourceBefore);
            const jobs = createPlaybackRepository(prisma);
            const claimed = (await jobs.claim())!;
            expect(claimed.assetId).toBe(original.assetId);
            await jobs.fail(claimed.id, claimed.leaseToken!, 'PLAYBACK_FAILED: retry test');
            expect(AdminProjectDetailSchema.parse((await detail()).json().data).videos[0]?.playbackJob).toMatchObject({ status: 'FAILED' });
            expect((await app.inject({ method: 'POST', url, headers: operator })).statusCode).toBe(202);
            expect((await app.inject({ method: 'POST', url, headers: admin })).statusCode).toBe(409);
            const replacement = (await jobs.claim())!;
            await jobs.bindSource(replacement.id, replacement.leaseToken!, 'test-source-sha');
            const outputs = [];
            for (const [profile, frameRate] of [['native', 120], ['cap60', 60], ['cap30', 30]] as const) {
                const rendition = await jobs.prepare(replacement.id, replacement.leaseToken!, profile, 'protected', `playback-test/${replacement.id}/${profile}.mp4`);
                outputs.push({ id: rendition.id, checksum: 'test-sha', sizeBytes: 10n, frameRate, width: 1920, height: 1080 });
            }
            await jobs.complete(replacement.id, replacement.leaseToken!, outputs);
            const playable = AdminProjectDetailSchema.parse((await detail()).json().data).videos[0]!;
            expect(playable.playbacks?.map(r => r.frameRate)).toEqual([120, 60, 30]);
            expect(playable.playbackStatus).toBe('READY');
            expect((await app.inject({ method: 'POST', url, headers: admin })).statusCode).toBe(202);
            expect(AdminProjectDetailSchema.parse((await detail()).json().data).videos[0]).toMatchObject({ playbackStatus: 'READY', url: playable.url, playbackJob: { status: 'PENDING' } });
            const legacy = await prisma.asset.create({ data: { projectId: p.id, kind: 'VIDEO', representations: { create: {
                role: 'ORIGINAL', state: 'READY', bucket: 'protected', objectKey: `legacy/${randomUUID()}`, sizeBytes: 10n, mimeType: 'video/mp4',
            } } } });
            const legacyRetry = `/api/admin/projects/${p.id}/videos/${legacy.id}/retry`;
            expect(await prisma.assetUploadSession.count({ where: { resultAssetId: legacy.id } })).toBe(0);
            expect((await app.inject({ method: 'POST', url: legacyRetry, headers: student })).statusCode).toBe(403);
            expect((await app.inject({ method: 'POST', url: legacyRetry, headers: admin })).statusCode).toBe(202);
            expect((await app.inject({ method: 'POST', url: legacyRetry, headers: admin })).statusCode).toBe(409);
			expect(await prisma.assetRepresentation.findUnique({ where: { id: sourceBefore.id } })).toEqual(sourceBefore);
		} finally { await app.close(); }
	});
});
