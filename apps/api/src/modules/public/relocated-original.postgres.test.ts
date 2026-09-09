import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClientForDatabase } from '../../lib/prisma-client.js';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { createPublicRepository } from './repository.js';

describe.runIf(process.env['RUN_POSTGRES_INTEGRATION'] === 'true')('relocated public original bridge PostgreSQL', () => {
	let db: PrismaClient;
	let control: PrismaClient;
	let schema: string;
	let projectId: number;
	const digest = 'a'.repeat(64);
	beforeAll(async () => {
		const databaseUrl = process.env['DATABASE_URL']!;
		control = createPrismaClientForDatabase(databaseUrl);
		schema = `public_alias_${randomUUID().replaceAll('-', '')}`;
		await control.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
		const migrationRoot = new URL('../../../prisma/migrations/', import.meta.url);
		for (const directory of (await readdir(migrationRoot)).filter((name) => name < '20260822000000' && name !== 'migration_lock.toml').sort()) {
			const connection = createPrismaClientForDatabase(databaseUrl);
			try { await connection.$executeRawUnsafe(`SET search_path TO "${schema}";\n${await readFile(new URL(`${directory}/migration.sql`, migrationRoot), 'utf8')}`); }
			finally { await connection.$disconnect(); }
		}
		const url = new URL(databaseUrl); url.searchParams.set('schema', schema); url.searchParams.set('options', `-c search_path=${schema}`);
		db = createPrismaClientForDatabase(url.toString());
		await db.$executeRawUnsafe(`INSERT INTO storage_buckets(bucket, visibility, updated_at) VALUES ('protected', 'PROTECTED', now()), ('public', 'PUBLIC', now())`);
		await db.$executeRawUnsafe(`INSERT INTO users(google_sub, updated_at) VALUES ('public-alias-test', now())`);
		await db.$executeRawUnsafe(`INSERT INTO exhibitions(year, title, updated_at) VALUES (2099, 'alias', now())`);
		const projects = await db.$queryRawUnsafe<Array<{ id: number }>>(`INSERT INTO projects(exhibition_id, creator_id, slug, title, status, updated_at)
			VALUES ((SELECT id FROM exhibitions LIMIT 1), (SELECT id FROM users LIMIT 1), 'alias', 'Alias', 'PUBLISHED', now()) RETURNING id`);
		projectId = projects[0]!.id;
	}, 120_000);
	afterAll(async () => { await db?.$disconnect(); if (control) { await control.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await control.$disconnect(); } });
	async function fixture(kind: 'POSTER' | 'VIDEO' | 'DOCUMENT' = 'POSTER') {
		const key = `${randomUUID()}.webp`;
		const destination = `canonical/${randomUUID()}.webp`;
		const bucket = kind === 'POSTER' ? 'public' : 'protected';
		const rows = await db.$queryRaw<Array<{ id: number }>>(Prisma.sql`INSERT INTO assets
			(project_id, kind, status, storage_key, mime_type, size_bytes, is_public, video_sort_order, updated_at)
			VALUES (${projectId}, ${kind}::"AssetKind", ${kind === 'DOCUMENT' ? 'PENDING' : 'READY'}::"AssetStatus", ${destination}, 'image/webp', 5, ${kind === 'POSTER'}, ${kind === 'VIDEO' ? 0 : null}, now()) RETURNING id`);
		const id = rows[0]!.id;
		const repId = randomUUID(); const relocationId = randomUUID();
		await db.$executeRaw(Prisma.sql`INSERT INTO asset_representations
			(id, asset_id, role, bucket, object_key, mime_type, size_bytes, checksum_algorithm, checksum, source_identity_algorithm, source_identity, state, updated_at)
			VALUES (${repId}, ${id}, 'ORIGINAL', ${bucket}, ${destination}, 'image/webp', 5, 'SHA256', ${digest}, 'MIGRATION_COPY_SHA256', ${digest}, 'READY', now())`);
		await db.$executeRaw(Prisma.sql`INSERT INTO canonical_object_relocations
			(id, work_kind, work_ref, role, source_bucket, source_object_key, destination_bucket, destination_object_key, size_bytes, mime_type, checksum_sha256, state, materialized_at, committed_at, updated_at)
			VALUES (${relocationId}, 'asset', ${String(id)}, 'ORIGINAL', 'public', ${key}, ${bucket}, ${destination}, 5, 'image/webp', ${digest}, 'COMMITTED', now(), now(), now())`);
		if (kind === 'DOCUMENT') await db.$executeRaw(Prisma.sql`UPDATE assets SET status = 'READY' WHERE id = ${id}`);
		return { id, key, repId, relocationId };
	}
	it('resolves a poster source key after storage_key changes and an extra proven source alias, while retaining corrected video access', async () => {
		const repo = createPublicRepository(db);
		for (const kind of ['POSTER', 'VIDEO'] as const) {
			const item = await fixture(kind);
			expect(await repo.resolvePublicImageBridge(item.key)).toEqual({ bucket: 'public', objectKey: item.key, usedLegacy: true });
			const alias = `alias-${item.key}`;
			await db.$executeRaw(Prisma.sql`INSERT INTO canonical_object_relocations
				SELECT ${randomUUID()}, work_kind, work_ref, role, source_bucket, ${alias}, destination_bucket, destination_object_key,
				 size_bytes, mime_type, checksum_sha256, state, materialized_at, committed_at, created_at, updated_at
				FROM canonical_object_relocations WHERE id = ${item.relocationId}`);
			expect(await repo.resolvePublicImageBridge(alias)).toEqual({ bucket: 'public', objectKey: alias, usedLegacy: true });
		}
	});
	it.each([
		['checksum', "checksum_sha256 = repeat('b', 64)"],
		['size', 'size_bytes = 6'],
		['MIME', "mime_type = 'image/png'"],
		['owner', "work_ref = '999999'"],
		['destination', "destination_object_key = 'unrelated'"],
		['private source', "source_bucket = 'protected'"],
		['uncommitted', "state = 'MATERIALIZED', committed_at = NULL"],
	] as const)('refuses a %s mismatch', async (_label, update) => {
		const item = await fixture();
		await db.$executeRawUnsafe(`UPDATE canonical_object_relocations SET ${update} WHERE id = '${item.relocationId}'`);
		expect(await createPublicRepository(db).resolvePublicImageBridge(item.key)).toBeNull();
	});
	it('refuses unpublished owners, private images, non-image materials, and a failed current original', async () => {
		const repo = createPublicRepository(db); const item = await fixture();
		await db.$executeRaw(Prisma.sql`UPDATE projects SET status = 'DRAFT' WHERE id = ${projectId}`);
		expect(await repo.resolvePublicImageBridge(item.key)).toBeNull();
		await db.$executeRaw(Prisma.sql`UPDATE projects SET status = 'PUBLISHED' WHERE id = ${projectId}`);
		await db.$executeRaw(Prisma.sql`UPDATE assets SET is_public = false WHERE id = ${item.id}`);
		expect(await repo.resolvePublicImageBridge(item.key)).toBeNull();
		await db.$executeRaw(Prisma.sql`UPDATE assets SET is_public = true WHERE id = ${item.id}`);
		await db.$executeRaw(Prisma.sql`UPDATE asset_representations SET state = 'FAILED' WHERE id = ${item.repId}`);
		expect(await repo.resolvePublicImageBridge(item.key)).toBeNull();
		const document = await fixture('DOCUMENT');
		expect(await repo.resolvePublicImageBridge(document.key)).toBeNull();
	});
});
