import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';
import { createAssetUploadRepository } from '../modules/asset-upload/repository.js';
import { createProjectCrudRepository } from '../modules/admin/project/crud.repository.js';
import { createVideoWorkerRepository } from '../modules/video/repository.js';
import type { VerifyingVideoSession } from '../modules/video/ports.js';

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
	async function allocate(projectId: number) {
		const id = randomUUID();
		return createAssetUploadRepository(prisma).createAllocating({
			id, projectId, exhibitionId: null, userId: actorId, kind: 'VIDEO', originalName: 'video.mp4', declaredMimeType: 'video/mp4', totalBytes: 10n,
			partSizeBytes: 10, totalParts: 1, bucket: 'protected', objectKey: `protected/uploads/${id}/source`, generation: 1,
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'a'.repeat(64), sourceIdentityBlockSizeBytes: 1_048_576,
			sourceIdentityBlockManifest: 'e30=', expiresAt: new Date(Date.now() + 60_000),
		});
	}
	async function commit(sessionId: string) {
		const session = await prisma.assetUploadSession.update({ where: { id: sessionId }, data: { state: 'VERIFYING', validationLeaseToken: 'lease', validationLeaseUntil: new Date(Date.now() + 60_000) } });
		return createVideoWorkerRepository(prisma).commitVideoReady({
			session: session as VerifyingVideoSession, token: 'lease', originalMimeType: 'video/mp4', originalSizeBytes: 10n,
			playback: { bucket: 'protected', objectKey: `${session.objectKey}/playback`, mimeType: 'video/mp4', sizeBytes: 10n },
		});
	}

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


	function savedVideo(index: number) {
		return { kind: 'VIDEO' as const, storageKey: `legacy/${randomUUID()}`, originalName: `${index}.mp4`, mimeType: 'video/mp4', sizeBytes: 10, playbackStatus: 'READY' as const };
	}
	it('keeps Phase-1 multipart submission order and rejects a sixth submitted video', async () => {
		const repo = createProjectCrudRepository(prisma, { publicBucket: 'public', protectedBucket: 'protected' });
		const data = { exhibitionId, creatorId: actorId, title: 'Multipart videos', slug: randomUUID(), status: 'PUBLISHED' as const, summary: '', description: '', members: [], savedFiles: [0, 1, 2, 3, 4].map(savedVideo) };
		const created = await repo.createProjectWithAssets(data);
		const assets = await prisma.asset.findMany({ where: { projectId: created.id }, orderBy: { videoSortOrder: 'asc' } });
		expect(assets.map(({ originalName, videoSortOrder }) => [originalName, videoSortOrder])).toEqual([0, 1, 2, 3, 4].map((index) => [`${index}.mp4`, index]));
		await expect(Promise.resolve().then(() => repo.createProjectWithAssets({ ...data, slug: randomUUID(), savedFiles: [...data.savedFiles, savedVideo(5)] }))).rejects.toMatchObject({ statusCode: 409 });
	});
	it('serializes competing legacy and direct uploads for the fifth video slot', async () => {
		const p = await project();
		const repo = createProjectCrudRepository(prisma, { publicBucket: 'public', protectedBucket: 'protected' });
		const legacy = () => repo.createAsset({ ...savedVideo(9), projectId: p.id, sizeBytes: 10n, playbackStorageKey: null, playbackSizeBytes: 0n, playbackMimeType: '', isPublic: false });
		for (let index = 0; index < 4; index++) await legacy();
		const outcomes = await Promise.allSettled([legacy(), allocate(p.id)]);
		expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
		expect(outcomes.find(({ status }) => status === 'rejected')).toMatchObject({ reason: { statusCode: 409 } });
		await expect(legacy()).rejects.toMatchObject({ statusCode: 409 });
	});
});
