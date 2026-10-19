import { readFile, writeFile } from 'node:fs/promises';
import { createPrismaClientForDatabase } from '../src/lib/prisma-client.js';
import { createPublicationTransitionRepository } from '../src/modules/migration/publication-transition.repository.js';
const [mode, path] = process.argv.slice(2);
if (!['preview', 'apply'].includes(mode ?? '') || !path || !process.env['DATABASE_URL']) throw new Error('Usage: DATABASE_URL=... tsx scripts/transition-project-publication.ts preview|apply manifest.json');
const db = createPrismaClientForDatabase(process.env['DATABASE_URL']);
try {
 const repository = createPublicationTransitionRepository(db);
 if (mode === 'preview') {
  const result = await repository.preview();
  await writeFile(path, JSON.stringify(result.candidates, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(result));
 } else console.log(JSON.stringify(await repository.apply(JSON.parse(await readFile(path, 'utf8')))));
} finally { await db.$disconnect(); }
