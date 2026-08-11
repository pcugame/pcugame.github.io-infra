import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';

const runPostgresIntegration = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';
const migrationUrl = new URL(
	'../../prisma/migrations/20260811000000_upload_lifecycle_durability/migration.sql',
	import.meta.url,
);

describe.runIf(runPostgresIntegration)('upload lifecycle migration invariants', () => {
	let prisma: PrismaClient;

	beforeAll(async () => {
		const databaseUrl = process.env['DATABASE_URL'];
		if (!databaseUrl) throw new Error('DATABASE_URL is required for PostgreSQL integration tests');
		prisma = createPrismaClientForDatabase(databaseUrl);
		await prisma.$connect();
	});

	afterAll(async () => {
		await prisma?.$disconnect();
	});

	it('executes the checked-in 1-4 MiB backfill and minimum constraint on legacy rows', async () => {
		const migration = await readFile(migrationUrl, 'utf8');
		const backfill = migration.match(
			/UPDATE "site_settings" SET "max_chunk_size_mb" = 5 WHERE "max_chunk_size_mb" < 5;/,
		)?.[0];
		const constraint = migration.match(
			/ALTER TABLE "site_settings"\s+ADD CONSTRAINT "site_settings_max_chunk_size_mb_min_5" CHECK \("max_chunk_size_mb" >= 5\);/,
		)?.[0];
		expect(backfill).toBeDefined();
		expect(constraint).toBeDefined();

		await prisma.$transaction(async (tx) => {
			await tx.$executeRawUnsafe(`
				CREATE TEMP TABLE "site_settings" (
					"id" TEXT PRIMARY KEY,
					"max_chunk_size_mb" INTEGER NOT NULL
				) ON COMMIT DROP
			`);
			await tx.$executeRawUnsafe(`
				INSERT INTO "site_settings" ("id", "max_chunk_size_mb")
				VALUES ('one', 1), ('two', 2), ('three', 3), ('four', 4), ('five', 5)
			`);
			await tx.$executeRawUnsafe(backfill!);
			await tx.$executeRawUnsafe(constraint!);
			const rows = await tx.$queryRawUnsafe<Array<{ maxChunkSizeMb: number }>>(`
				SELECT "max_chunk_size_mb" AS "maxChunkSizeMb"
				FROM "site_settings"
				ORDER BY "id"
			`);
			expect(rows.map(({ maxChunkSizeMb }) => maxChunkSizeMb)).toEqual([5, 5, 5, 5, 5]);
		});
	});

	it('rejects 4 MiB and accepts 5 MiB in the migrated production table', async () => {
		const id = `integration-chunk-floor-${randomUUID()}`;
		try {
			await prisma.siteSetting.create({
				data: { id, maxGameFileMb: 10, maxChunkSizeMb: 5 },
			});
			await expect(prisma.siteSetting.update({
				where: { id },
				data: { maxChunkSizeMb: 4 },
			})).rejects.toThrow();
			await expect(prisma.siteSetting.findUniqueOrThrow({ where: { id } }))
				.resolves.toMatchObject({ maxChunkSizeMb: 5 });
		} finally {
			await prisma.siteSetting.deleteMany({ where: { id } });
		}
	});
});
