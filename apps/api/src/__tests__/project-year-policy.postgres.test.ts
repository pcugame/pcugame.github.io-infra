import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createIsolatedMigratedDatabase } from './helpers/isolated-migrated-database.js';
import { createProjectCrudRepository } from '../modules/admin/project/crud.repository.js';
import { assertProjectUploadWriteAccessInTransaction } from '../modules/admin/project-access.service.js';

const enabled = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';

describe.runIf(enabled)('project year modification policy PostgreSQL', () => {
	let db: PrismaClient;
	let database: Awaited<ReturnType<typeof createIsolatedMigratedDatabase>>;
	let exhibitionId: number;
	let owner: { id: number; role: 'USER' };
	let member: { id: number; role: 'USER' };
	let stranger: { id: number; role: 'USER' };
	let operator: { id: number; role: 'OPERATOR' };
	const projectIds: number[] = [];
	const userIds: number[] = [];
	beforeAll(async () => {
		database = await createIsolatedMigratedDatabase(process.env['DATABASE_URL']!);
		db = database.createClient();
		async function user<T extends 'USER' | 'OPERATOR'>(role: T): Promise<{ id: number; role: T }> { const row = await db.user.create({ data: { googleSub: randomUUID(), email: `${randomUUID()}@test.invalid`, role } }); userIds.push(row.id); return { id: row.id, role }; }
		owner = await user('USER'); member = await user('USER'); stranger = await user('USER'); operator = await user('OPERATOR');
		exhibitionId = (await db.exhibition.create({ data: { year: 28000, title: randomUUID(), isModificationEnabled: false } })).id;
	});
	afterAll(async () => { await database?.close(); });
	async function project() { const row = await db.project.create({ data: { exhibitionId, creatorId: owner.id, slug: randomUUID(), title: 'before', status: 'PUBLISHED', members: { create: { userId: member.id, name: 'member' } } } }); projectIds.push(row.id); return row; }
	it('rejects closed owner/member/stranger writes, allows operator, then allows owner and member after opening', async () => {
		const item = await project(); const repo = createProjectCrudRepository(db);
		for (const actor of [owner, member, stranger]) await expect(repo.updateProject(item.id, { title: 'blocked' }, actor)).rejects.toMatchObject({ statusCode: 403 });
		await expect(repo.updateProject(item.id, { title: 'operator' }, operator)).resolves.toMatchObject({ title: 'operator' });
		await db.exhibition.update({ where: { id: exhibitionId }, data: { isModificationEnabled: true } });
		await expect(repo.updateProject(item.id, { title: 'owner' }, owner)).resolves.toMatchObject({ title: 'owner' });
		await expect(repo.updateProject(item.id, { title: 'member' }, member)).resolves.toMatchObject({ title: 'member' });
	});
	it('rechecks a late worker write after the year closes', async () => {
		const item = await project(); await db.exhibition.update({ where: { id: exhibitionId }, data: { isModificationEnabled: false } });
		await expect(db.$transaction((tx) => assertProjectUploadWriteAccessInTransaction(tx, owner, item.id))).rejects.toMatchObject({ statusCode: 403 });
	});
});
