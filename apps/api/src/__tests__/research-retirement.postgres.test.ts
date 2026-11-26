import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createIsolatedMigratedDatabase } from './helpers/isolated-migrated-database.js';

const migration = '20261126130000_retire_nickname_lab';
it.runIf(process.env.RUN_POSTGRES_INTEGRATION === 'true')('retirement preserves unverified research and exhibition references on failure', async () => {
  const db = await createIsolatedMigratedDatabase(process.env.DATABASE_URL!, migration);
  const client = db.createClient();
  const sql = await readFile(new URL(`../../prisma/migrations/${migration}/migration.sql`, import.meta.url), 'utf8');
  async function apply() {
    // A failed explicit SQL transaction owns its connection until rolled back or closed.
    const migrationClient = db.createClient();
    try { await migrationClient.$executeRawUnsafe(sql); }
    finally { await migrationClient.$disconnect(); }
  }
  try {
    const user = await client.user.create({data: {googleSub: 'retirement-test'}});
    const exhibition = await client.exhibition.create({data: {year: 2099, title: 'Retirement test'}});
    const project = await client.project.create({data: {exhibitionId: exhibition.id, creatorId: user.id, slug: 'keep', title: 'Keep'}});
    await client.$executeRaw`INSERT INTO "LabFamilySplit" ("familyId",split) VALUES ('unsaved','train')`;
    await expect(apply()).rejects.toThrow(/differs from verified restore/);
    expect(await client.$queryRaw`SELECT split FROM "LabFamilySplit" WHERE "familyId"='unsaved'`).toEqual([{split:'train'}]);

    await client.$executeRaw`DELETE FROM "LabFamilySplit" WHERE "familyId"='unsaved'`;
    await client.$executeRaw`UPDATE users SET role='BETA_TESTER' WHERE id=${user.id}`;
    await expect(apply()).rejects.toThrow(/Convert retired roles/);
    expect(await client.$queryRaw`SELECT role::text AS role FROM users WHERE id=${user.id}`).toEqual([{role:'BETA_TESTER'}]);
    await client.$executeRaw`UPDATE users SET role='USER' WHERE id=${user.id}`;
    await apply();
    expect(await client.$queryRaw`SELECT enum_range(NULL::"UserRole")::text AS roles`).toEqual([{roles:'{USER,OPERATOR,ADMIN}'}]);
    expect(await client.project.findUnique({where:{id:project.id}})).toMatchObject({exhibitionId: exhibition.id, creatorId:user.id});
  } finally { await db.close(); }
});
