import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createIsolatedMigratedDatabase } from './helpers/isolated-migrated-database.js';

it.runIf(process.env['RUN_POSTGRES_INTEGRATION'] === 'true')('widens the award icon constraint without changing legacy icons, photos or recipients', async () => {
 const database = await createIsolatedMigratedDatabase(process.env['DATABASE_URL']!);
 const db = database.createClient();
 try {
  // Re-establish the preceding constraint in this isolated schema, then seed legacy data.
  await db.$executeRawUnsafe(`ALTER TABLE exhibition_awards DROP CONSTRAINT exhibition_awards_builtin_key_check;
   ALTER TABLE exhibition_awards ADD CONSTRAINT exhibition_awards_builtin_key_check
   CHECK (builtin_key IS NULL OR builtin_key IN ('medal', 'trophy', 'ribbon'));`);
  const exhibition = await db.exhibition.create({ data: { year: 2097, title: 'Migration fixture' } });
  const user = await db.user.create({ data: { googleSub: 'migration-fixture', email: 'migration@test.invalid' } });
  const project = await db.project.create({ data: { exhibitionId: exhibition.id, creatorId: user.id, title: 'Legacy project', slug: 'legacy-project' } });
  const asset = await db.asset.create({ data: { exhibitionId: exhibition.id, kind: 'IMAGE', status: 'PENDING', originalName: 'custom.png' } });
  for (const [index, builtinKey] of ['medal', 'trophy', 'ribbon', null].entries()) {
   const award = await db.exhibitionAward.create({ data: { exhibitionId: exhibition.id, name: `Legacy ${index}`, sortOrder: index, builtinKey, assetId: builtinKey ? null : asset.id } });
   await db.projectAward.create({ data: { projectId: project.id, exhibitionId: exhibition.id, awardId: award.id } });
  }
  const before = await db.exhibitionAward.findMany({ orderBy: { id: 'asc' }, include: { recipients: true } });
  const migration = await readFile(new URL('../../prisma/migrations/20261102000100_laurel_award_icons/migration.sql', import.meta.url), 'utf8');
  await db.$executeRawUnsafe(migration);
  expect(await db.exhibitionAward.findMany({ orderBy: { id: 'asc' }, include: { recipients: true } })).toEqual(before);
  for (const builtinKey of ['laurel-gold', 'laurel-silver', 'laurel-bronze', 'laurel-slate']) {
   await expect(db.exhibitionAward.create({ data: { exhibitionId: exhibition.id, name: builtinKey, sortOrder: 4, builtinKey } })).resolves.toMatchObject({ builtinKey });
  }
  await expect(db.exhibitionAward.create({ data: { exhibitionId: exhibition.id, name: 'Invalid', sortOrder: 5, builtinKey: 'laurel-invalid' } })).rejects.toThrow();
  await expect(db.exhibitionAward.create({ data: { exhibitionId: exhibition.id, name: 'Both', sortOrder: 6, builtinKey: 'laurel-gold', assetId: asset.id } })).rejects.toThrow();
 } finally { await database.close(); }
});
