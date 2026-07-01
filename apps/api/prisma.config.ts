import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

const isGenerate = process.argv.includes('generate');
const databaseUrl =
  process.env['DATABASE_URL']
  ?? (isGenerate
    ? 'postgresql://prisma:prisma@localhost:5432/prisma?schema=public'
    : env('DATABASE_URL'));

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: databaseUrl,
  },
});
