import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';
import { createProjectCrudRepository } from '../modules/admin/project/crud.repository.js';
import { createAssetsRepository } from '../modules/assets/repository.js';

const enabled = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';
describe.runIf(enabled)('project video ordering transactions', () => {
	const schema = `video_order_${randomUUID().replaceAll('-', '')}`;
	let control: PrismaClient;
	let db: PrismaClient;
	let creatorId: number;
	let exhibitionId: number;
	const projects: number[] = [];
	beforeAll(async () => {
		const url = new URL(process.env['DATABASE_URL']!);
		control = createPrismaClientForDatabase(url.toString());
		await control.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
		const root = new URL('../../prisma/migrations/', import.meta.url);
		for (const migration of (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name < '20260822000000_canonical_asset_contract').map(({ name }) => name).sort()) {
			const connection = createPrismaClientForDatabase(url.toString());
			try { await connection.$executeRawUnsafe(`SET search_path TO "${schema}";\n${await readFile(new URL(`${migration}/migration.sql`, root), 'utf8')}`); }
			finally { await connection.$disconnect(); }
		}
		url.searchParams.set('schema', schema);
		url.searchParams.set('options', `-c search_path=${schema}`);
		db = createPrismaClientForDatabase(url.toString());
		await db.storageBucket.upsert({ where: { bucket: 'video-order-test' }, create: { bucket: 'video-order-test', visibility: 'PROTECTED' }, update: {} });
		const token = randomUUID();
		creatorId = (await db.user.create({ data: { googleSub: token, email: `${token}@example.test`, name: 'Video order test' } })).id;
		exhibitionId = (await db.exhibition.create({ data: { year: 2098, title: token } })).id;
	}, 60_000);
	afterAll(async () => {
		await db?.$disconnect();
		if (control) {
			await control.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
			await control.$disconnect();
		}
	});
	async function fixture(orders: Array<number | null> = [0, 1, 2], status: 'DRAFT' | 'PUBLISHED' = 'PUBLISHED') {
		const project = await db.project.create({ data: { exhibitionId, creatorId, slug: randomUUID(), title: 'Video test', status } });
		projects.push(project.id);
		const ids: number[] = [];
		for (const videoSortOrder of orders) ids.push((await db.asset.create({ data: {
			projectId: project.id, kind: 'VIDEO', status: 'READY', originalName: 'video.mp4', videoSortOrder,
			representations: { create: { role: 'ORIGINAL', state: 'READY', bucket: 'video-order-test', objectKey: `videos/${randomUUID()}`, mimeType: 'video/mp4', sizeBytes: 10n } },
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
		await db.asset.create({ data: { projectId, kind: 'VIDEO', status: 'READY', originalName: 'old-runtime.mp4', representations: { create: { role: 'ORIGINAL', state: 'READY', bucket: 'video-order-test', objectKey: `videos/${randomUUID()}`, mimeType: 'video/mp4', sizeBytes: 10n } } } });
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
	it('refuses reorder for an over-limit legacy project without removing videos', async () => {
		const { projectId, ids } = await fixture([0, 1, 2, 3, 4, null]);
		await expect(createProjectCrudRepository(db).setProjectVideoOrder(projectId, ids, ids)).rejects.toMatchObject({ statusCode: 409 });
		expect(await current(projectId)).toHaveLength(6);
	});
	it('allows deleting overflow legacy videos until the remaining five can be normalized', async () => {
		const { projectId, ids } = await fixture([0, 1, 2, 3, 4, null, null]);
		const repo = createAssetsRepository(db);
		await repo.claimAssetForDeletion(ids[6]!);
		expect(await current(projectId)).toHaveLength(6);
		await repo.claimAssetForDeletion(ids[0]!);
		expect((await current(projectId)).map(({ videoSortOrder }) => videoSortOrder)).toEqual([0, 1, 2, 3, 4]);
	});

});
