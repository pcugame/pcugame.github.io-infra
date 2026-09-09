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
	async function allocate(projectId: number, item?: { id: string; clientToken: string }) {
		const id = randomUUID();
		return createAssetUploadRepository(prisma).createAllocating({
			id, projectId, exhibitionId: null, userId: actorId, kind: 'VIDEO', originalName: 'video.mp4', declaredMimeType: 'video/mp4', totalBytes: 10n,
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
});
