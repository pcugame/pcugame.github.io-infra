import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';
import { createProjectCrudRepository } from '../modules/admin/project/crud.repository.js';
import { createAssetsRepository } from '../modules/assets/repository.js';

const enabled = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';
describe.runIf(enabled)('project video ordering transactions', () => {
	let db: PrismaClient;
	let creatorId: number;
	let exhibitionId: number;
	const projects: number[] = [];
	let protectedBucket = 'protected';
	beforeAll(async () => {
		db = createPrismaClientForDatabase(process.env['DATABASE_URL']!);
		protectedBucket = (await db.storageBucket.findUnique({ where: { visibility: 'PROTECTED' } }))?.bucket ?? protectedBucket;
		await db.storageBucket.upsert({ where: { bucket: protectedBucket }, create: { bucket: protectedBucket, visibility: 'PROTECTED' }, update: {} });
		const token = randomUUID();
		creatorId = (await db.user.create({ data: { googleSub: token, email: `${token}@example.test`, name: 'Video order test' } })).id;
		exhibitionId = (await db.exhibition.create({ data: { year: 2098, title: token } })).id;
	});
	afterAll(async () => {
		if (!db) return;
		await db.project.deleteMany({ where: { id: { in: projects } } });
		if (exhibitionId) await db.exhibition.delete({ where: { id: exhibitionId } });
		if (creatorId) await db.user.delete({ where: { id: creatorId } });
		await db.$disconnect();
	});
	async function fixture(orders: Array<number | null> = [0, 1, 2], status: 'DRAFT' | 'PUBLISHED' = 'PUBLISHED') {
		const project = await db.project.create({ data: { exhibitionId, creatorId, slug: randomUUID(), title: 'Video test', status } });
		projects.push(project.id);
		const ids: number[] = [];
		for (const videoSortOrder of orders) ids.push((await db.asset.create({ data: {
			projectId: project.id, kind: 'VIDEO', status: 'READY', originalName: 'video.mp4', videoSortOrder,
			representations: { create: { role: 'ORIGINAL', state: 'READY', bucket: protectedBucket, objectKey: `videos/${randomUUID()}`, mimeType: 'video/mp4', sizeBytes: 10n } },
		} })).id);
		return { projectId: project.id, ids };
	}
	async function current(projectId: number) {
		return db.asset.findMany({ where: { projectId, kind: 'VIDEO', status: 'READY' },
			select: { id: true, videoSortOrder: true }, orderBy: [{ videoSortOrder: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }] });
	}
	it('rewrites a complete permutation without unique collisions and rejects stale, missing, duplicate and foreign ids', async () => {
		const { projectId, ids } = await fixture();
		const repo = createProjectCrudRepository(db);
		const reversed = [...ids].reverse();
		await expect(repo.setProjectVideoOrder(projectId, ids, reversed)).resolves.toEqual({ order: reversed });
		expect(await current(projectId)).toEqual(reversed.map((id, videoSortOrder) => ({ id, videoSortOrder })));
		for (const [expected, order] of [[ids, ids], [reversed, ids.slice(1)], [reversed, [ids[0]!, ids[0]!, ids[2]!]], [reversed, [ids[0]!, ids[1]!, 999999999]]]) {
			await expect(repo.setProjectVideoOrder(projectId, expected!, order!)).rejects.toMatchObject({ statusCode: 409 });
		}
		expect(await current(projectId)).toEqual(reversed.map((id, videoSortOrder) => ({ id, videoSortOrder })));
	});
	it('normalizes NULL orders only in the accepted mutation and rejects stale membership after an add', async () => {
		const { projectId, ids } = await fixture([0, null, null]);
		const repo = createProjectCrudRepository(db);
		await repo.setProjectVideoOrder(projectId, ids, ids);
		expect((await current(projectId)).map((a) => a.videoSortOrder)).toEqual([0, 1, 2]);
		await db.asset.create({ data: { projectId, kind: 'VIDEO', status: 'READY', originalName: 'old-runtime.mp4', representations: { create: { role: 'ORIGINAL', state: 'READY', bucket: protectedBucket, objectKey: `videos/${randomUUID()}`, mimeType: 'video/mp4', sizeBytes: 10n } } } });
		await expect(repo.setProjectVideoOrder(projectId, ids, ids)).rejects.toMatchObject({ statusCode: 409 });
	});
	it('allows only one concurrent reorder with the same expected order', async () => {
		const { projectId, ids } = await fixture();
		const repo = createProjectCrudRepository(db);
		const results = await Promise.allSettled([
			repo.setProjectVideoOrder(projectId, ids, [...ids].reverse()),
			repo.setProjectVideoOrder(projectId, ids, [ids[1]!, ids[2]!, ids[0]!]),
		]);
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { statusCode: 409 } });
	});
	it.each([0, 1, 2])('deletes index %i and promotes/compacts remaining video order', async (index) => {
		const { projectId, ids } = await fixture();
		const repo = createAssetsRepository(db);
		await repo.claimAssetForDeletion(ids[index]!);
		const remaining = ids.filter((_, i) => i !== index);
		expect(await current(projectId)).toEqual(remaining.map((id, videoSortOrder) => ({ id, videoSortOrder })));
		expect((await db.asset.findUniqueOrThrow({ where: { id: ids[index]! } })).status).toBe('DELETING');
		await expect(createProjectCrudRepository(db).setProjectVideoOrder(projectId, ids, ids)).rejects.toMatchObject({ statusCode: 409 });
	});
	it.each(['PENDING', 'FINALIZING'] as const)('blocks ordinary reorder and delete during %s submission', async (state) => {
		const { projectId, ids } = await fixture([0, 1, 2], 'DRAFT');
		await db.projectSubmission.create({ data: { projectId, actorId: creatorId, state } });
		await expect(createProjectCrudRepository(db).setProjectVideoOrder(projectId, ids, ids)).rejects.toMatchObject({ statusCode: 409 });
		await expect(createAssetsRepository(db).claimAssetForDeletion(ids[0]!)).rejects.toMatchObject({ statusCode: 409 });
		expect(await current(projectId)).toHaveLength(3);
	});
	it('refuses reorder for an over-limit legacy project without removing videos', async () => {
		const { projectId, ids } = await fixture([0, 1, 2, 3, 4, null]);
		await expect(createProjectCrudRepository(db).setProjectVideoOrder(projectId, ids, ids)).rejects.toMatchObject({ statusCode: 409 });
		expect(await current(projectId)).toHaveLength(6);
	});
});
