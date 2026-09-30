import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createIsolatedMigratedDatabase } from './helpers/isolated-migrated-database.js';

const enabled = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';

describe.runIf(enabled)('visibility legacy rollback fence', () => {
	let database: Awaited<ReturnType<typeof createIsolatedMigratedDatabase>>;
	let db: PrismaClient;
	let sql: string;
	beforeAll(async () => {
		database = await createIsolatedMigratedDatabase(process.env['DATABASE_URL']!);
		db = database.createClient();
		const script = await readFile(new URL('../../../../server/deploy.sh', import.meta.url), 'utf8');
		const section = script.split('assert_visibility_rollback_safe() {')[1]!.split('assert_phase1_rollback_authorization()')[0]!;
		sql = section.split("<<'SQL'\n")[1]!.split('\nSQL')[0]!;
	});
	afterAll(async () => { await database?.close(); });
	it('permits public data and refuses either a restricted exhibition or project', async () => {
		const user = await db.user.create({ data: { googleSub: randomUUID(), email: `${randomUUID()}@test.invalid` } });
		const exhibition = await db.exhibition.create({ data: { year: 2026, title: randomUUID() } });
		const project = await db.project.create({ data: { exhibitionId: exhibition.id, creatorId: user.id, slug: 'rollback', title: 'rollback' } });
		await expect(db.$executeRawUnsafe(sql)).resolves.toBeDefined();
		await db.exhibition.update({ where: { id: exhibition.id }, data: { visibility: 'AUTHENTICATED' } });
		await expect(db.$executeRawUnsafe(sql)).rejects.toThrow(/Restricted visibility data exists/);
		await db.exhibition.update({ where: { id: exhibition.id }, data: { visibility: 'PUBLIC' } });
		await db.project.update({ where: { id: project.id }, data: { visibility: 'STAFF' } });
		await expect(db.$executeRawUnsafe(sql)).rejects.toThrow(/Restricted visibility data exists/);
	});
});
