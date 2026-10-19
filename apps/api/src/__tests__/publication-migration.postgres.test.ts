import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createIsolatedMigratedDatabase } from './helpers/isolated-migrated-database.js';

describe.runIf(process.env['RUN_POSTGRES_INTEGRATION'] === 'true')('publication expansion migration', () => {
 it('rolls back failed expansion, preserves legacy publication and cancellation history on retry', async () => {
  const migration = '20261019000000_project_publication_expand';
  const database = await createIsolatedMigratedDatabase(process.env['DATABASE_URL']!, migration);
  const db = database.createClient();
  try {
   await db.$executeRawUnsafe(`
    INSERT INTO users(id,google_sub,email,updated_at) VALUES(1,'migration-test','test@example.invalid',now());
    INSERT INTO exhibitions(id,year,title,updated_at) VALUES(1,2090,'Migration',now());
    INSERT INTO projects(id,exhibition_id,creator_id,title,slug,status,visibility,updated_at) VALUES
     (1,1,1,'Published','published','PUBLISHED','PUBLIC',now()),
     (2,1,1,'Archived','archived','ARCHIVED','AUTHENTICATED',now()),
     (3,1,1,'Private','private','PUBLISHED','STAFF',now()),
     (4,1,1,'Cancelled','cancelled','DRAFT','PUBLIC',now());
    INSERT INTO project_submissions(id,project_id,actor_id,state,updated_at,cancelled_at) VALUES('cancelled',4,1,'CANCELLED',now(),now());
   `);
   const sql = await readFile(new URL(`../../prisma/migrations/${migration}/migration.sql`, import.meta.url), 'utf8');
   // Inject a failure before COMMIT; DDL and data must both roll back.
   await expect(db.$executeRawUnsafe(sql.replace('COMMIT;', 'SELECT 1 / 0; COMMIT;'))).rejects.toThrow();
   await db.$executeRawUnsafe('ROLLBACK');
   expect(await db.$queryRawUnsafe<Array<{count:bigint}>>(`SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='projects' AND column_name='publication_status'`)).toEqual([{count:0n}]);
   await db.$executeRawUnsafe(sql);
   expect(await db.project.findMany({orderBy:{id:'asc'},select:{id:true,publicationStatus:true,legacyPublication:true,hiddenCancelled:true}})).toEqual([
    {id:1,publicationStatus:'PUBLIC',legacyPublication:true,hiddenCancelled:false},
    {id:2,publicationStatus:'PUBLIC',legacyPublication:true,hiddenCancelled:false},
    {id:3,publicationStatus:'PRIVATE',legacyPublication:false,hiddenCancelled:false},
    {id:4,publicationStatus:'PRIVATE',legacyPublication:false,hiddenCancelled:true},
   ]);
   expect(await db.publicationException.count({where:{kind:'LEGACY'}})).toBe(2);
   expect(await db.projectSubmission.findUnique({where:{id:'cancelled'}})).toMatchObject({state:'CANCELLED'});
  } finally { await database.close(); }
 }, 60000);
});
