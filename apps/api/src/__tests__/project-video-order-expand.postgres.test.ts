import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';

const runPostgresIntegration = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';
const migrationRootUrl = new URL('../../prisma/migrations/', import.meta.url);
const priorPhaseOneCeiling = '20260821700000_canonical_object_relocation_expand';
const projectVideoOrderMigration = '20260821800000_project_video_order_expand';
const canonicalContractMigration = '20260822000000_canonical_asset_contract';

function quoted(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

describe.runIf(runPostgresIntegration)('project video order expand PostgreSQL migration', () => {
	let databaseUrl = '';
	let control: PrismaClient;
	const schemas: string[] = [];

	async function freshPhaseOneSchema(label: string): Promise<string> {
		const schema = `project_video_order_${label}_${randomUUID().replaceAll('-', '')}`;
		await control.$executeRawUnsafe(`CREATE SCHEMA ${quoted(schema)}`);
		schemas.push(schema);
		const directories = (await readdir(migrationRootUrl, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory() && entry.name <= priorPhaseOneCeiling)
			.map((entry) => entry.name)
			.sort();
		expect(directories.at(-1)).toBe(priorPhaseOneCeiling);
		for (const directory of directories) await applyMigration(schema, directory);
		return schema;
	}

	async function applyMigration(schema: string, directory: string): Promise<void> {
		const sql = await readFile(new URL(`${directory}/migration.sql`, migrationRootUrl), 'utf8');
		const connection = createPrismaClientForDatabase(databaseUrl);
		try {
			await connection.$connect();
			await connection.$executeRawUnsafe(`SET search_path TO ${quoted(schema)};\n${sql}`);
		} finally {
			await connection.$disconnect();
		}
	}

	async function seedProjects(schema: string, projectIds: readonly number[]): Promise<void> {
		const projectValues = projectIds.map((id) => (
			`(${id}, 901, 'project-${id}', 'Project ${id}', 900, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
		)).join(', ');
		await control.$executeRawUnsafe(`
			SET search_path TO ${quoted(schema)};
			INSERT INTO "users" ("id", "google_sub", "email", "name", "picture", "role", "created_at", "updated_at")
			VALUES (900, 'video-order-owner', 'video-order@example.test', 'Video order owner', '', 'ADMIN', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
			INSERT INTO "exhibitions" ("id", "year", "title", "created_at", "updated_at")
			VALUES (901, 2026, 'Video order migration', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
			INSERT INTO "projects" ("id", "exhibition_id", "slug", "title", "creator_id", "created_at", "updated_at")
			VALUES ${projectValues};
		`);
	}

	async function assetCount(schema: string): Promise<bigint> {
		const [row] = await control.$queryRawUnsafe<Array<{ count: bigint }>>(`
			SELECT count(*) AS "count" FROM ${quoted(schema)}."assets"
		`);
		return row!.count;
	}

	async function assertNoVideoOrderColumn(schema: string): Promise<void> {
		const [row] = await control.$queryRawUnsafe<Array<{ present: boolean }>>(`
			SELECT EXISTS (
				SELECT 1 FROM information_schema.columns
				WHERE table_schema = '${schema}' AND table_name = 'assets'
					AND column_name = 'video_sort_order'
			) AS "present"
		`);
		expect(row?.present).toBe(false);
	}

	beforeAll(async () => {
		databaseUrl = process.env['DATABASE_URL'] ?? '';
		if (!databaseUrl) throw new Error('DATABASE_URL is required for PostgreSQL integration tests');
		control = createPrismaClientForDatabase(databaseUrl);
		await control.$connect();
	});

	afterAll(async () => {
		if (!control) return;
		for (const schema of schemas) {
			await control.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${quoted(schema)} CASCADE`).catch(() => undefined);
		}
		await control.$disconnect();
	});

	it('applies alone on the existing Phase 1 schema, backfills deterministically, and enforces video-only READY slots', async () => {
		const schema = await freshPhaseOneSchema('success');
		await seedProjects(schema, [910, 911]);
		await control.$executeRawUnsafe(`
			SET search_path TO ${quoted(schema)};
			INSERT INTO "assets" (
				"id", "project_id", "kind", "status", "original_name", "created_at", "updated_at"
			) VALUES
				(1003, 910, 'VIDEO', 'READY', 'third.mp4', '2026-08-01T00:00:02.000Z', CURRENT_TIMESTAMP),
				(1002, 910, 'VIDEO', 'READY', 'second.mp4', '2026-08-01T00:00:01.000Z', CURRENT_TIMESTAMP),
				(1001, 910, 'VIDEO', 'READY', 'first.mp4', '2026-08-01T00:00:01.000Z', CURRENT_TIMESTAMP),
				(1004, 911, 'VIDEO', 'READY', 'other-project.mp4', '2026-08-01T00:00:03.000Z', CURRENT_TIMESTAMP),
				(1005, 910, 'VIDEO', 'FAILED', 'failed.mp4', '2026-08-01T00:00:04.000Z', CURRENT_TIMESTAMP);
		`);

		await applyMigration(schema, projectVideoOrderMigration);

		const rows = await control.$queryRawUnsafe<Array<{ id: number; projectId: number; sortOrder: number | null }>>(`
			SELECT "id", "project_id" AS "projectId", "video_sort_order" AS "sortOrder"
			FROM ${quoted(schema)}."assets" ORDER BY "id"
		`);
		expect(rows).toEqual([
			{ id: 1001, projectId: 910, sortOrder: 0 },
			{ id: 1002, projectId: 910, sortOrder: 1 },
			{ id: 1003, projectId: 910, sortOrder: 2 },
			{ id: 1004, projectId: 911, sortOrder: 0 },
			{ id: 1005, projectId: 910, sortOrder: null },
		]);

		const [catalog] = await control.$queryRawUnsafe<Array<{
			shapeCheck: boolean;
			readyIndex: string | null;
			activeSessionIndex: string | null;
		}>>(`
			SELECT
				EXISTS (SELECT 1 FROM information_schema.table_constraints
					WHERE constraint_schema = '${schema}' AND table_name = 'assets'
						AND constraint_name = 'assets_video_sort_order_shape_check') AS "shapeCheck",
				pg_get_indexdef(to_regclass('${schema}.asset_project_video_ready_order_unique')) AS "readyIndex",
				pg_get_indexdef(to_regclass('${schema}.asset_upload_sessions_active_project_kind_key')) AS "activeSessionIndex"
		`);
		expect(catalog).toMatchObject({
			shapeCheck: true,
			readyIndex: expect.stringContaining('WHERE ((status = \'READY\'::"AssetStatus") AND (kind = \'VIDEO\'::"AssetKind") AND (video_sort_order IS NOT NULL))'),
			activeSessionIndex: expect.stringContaining('(kind <> \'VIDEO\'::"AssetUploadKind")'),
		});

		await expect(control.$executeRawUnsafe(`
			INSERT INTO ${quoted(schema)}."assets"
				("id", "project_id", "kind", "status", "video_sort_order", "original_name", "created_at", "updated_at")
			VALUES (1006, 910, 'VIDEO', 'READY', 0, 'duplicate.mp4', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		`)).rejects.toThrow(/asset_project_video_ready_order_unique/);
		await expect(control.$executeRawUnsafe(`
			INSERT INTO ${quoted(schema)}."assets"
				("id", "project_id", "kind", "status", "video_sort_order", "original_name", "created_at", "updated_at")
			VALUES (1007, 910, 'IMAGE', 'READY', 0, 'not-video.webp', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		`)).rejects.toThrow(/assets_video_sort_order_shape_check/);
		await expect(control.$executeRawUnsafe(`
			INSERT INTO ${quoted(schema)}."assets"
				("id", "project_id", "kind", "status", "video_sort_order", "original_name", "created_at", "updated_at")
			VALUES (1008, 910, 'VIDEO', 'FAILED', 5, 'out-of-range.mp4', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		`)).rejects.toThrow(/assets_video_sort_order_shape_check/);

		await expect(control.$executeRawUnsafe(`
			INSERT INTO ${quoted(schema)}."assets"
				("id", "project_id", "kind", "status", "video_sort_order", "original_name", "created_at", "updated_at")
			VALUES (1009, 910, 'VIDEO', 'FAILED', 0, 'failed-slot-reuse.mp4', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		`)).resolves.toBeDefined();

		const activeSessionColumns = `
			"id", "project_id", "user_id", "kind", "state", "original_name", "total_bytes",
			"part_size_bytes", "total_parts", "bucket", "object_key", "source_identity_algorithm",
			"source_identity", "source_identity_block_size_bytes", "source_identity_block_manifest",
			"expires_at", "created_at", "updated_at"
		`;
		const sessionValues = (id: string, kind: 'VIDEO' | 'GAME') => `
			('${id}', 910, 900, '${kind}', 'ALLOCATING', '${id}.bin', 1, 1, 1,
			 'protected', 'protected/uploads/${id}.bin', 'test', '${id}', 1, '{}'::jsonb,
			 CURRENT_TIMESTAMP + interval '1 hour', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		`;
		await control.$executeRawUnsafe(`
			INSERT INTO ${quoted(schema)}."asset_upload_sessions" (${activeSessionColumns}) VALUES
			${sessionValues('video-session-1', 'VIDEO')},
			${sessionValues('video-session-2', 'VIDEO')}
		`);
		await control.$executeRawUnsafe(`
			INSERT INTO ${quoted(schema)}."asset_upload_sessions" (${activeSessionColumns}) VALUES
			${sessionValues('game-session-1', 'GAME')}
		`);
		await expect(control.$executeRawUnsafe(`
			INSERT INTO ${quoted(schema)}."asset_upload_sessions" (${activeSessionColumns}) VALUES
			${sessionValues('game-session-2', 'GAME')}
		`)).rejects.toThrow(/asset_upload_sessions_active_project_kind_key/);
	});

	it('fails closed and leaves the old Phase 1 schema intact when a READY video is not exclusively project-owned', async () => {
		const schema = await freshPhaseOneSchema('bad_owner');
		await seedProjects(schema, [920]);
		await control.$executeRawUnsafe(`
			SET search_path TO ${quoted(schema)};
			INSERT INTO "assets" ("id", "exhibition_id", "kind", "status", "original_name", "created_at", "updated_at")
			VALUES (1010, 901, 'VIDEO', 'READY', 'exhibition-video.mp4', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		`);

		await expect(applyMigration(schema, projectVideoOrderMigration)).rejects.toThrow(
			/project video order expand blocked: 1 READY VIDEO assets are not project-owned exclusively/,
		);
		await assertNoVideoOrderColumn(schema);
		expect(await assetCount(schema)).toBe(1n);
	});

	it('fails closed and leaves the old Phase 1 schema intact when a project exceeds five READY videos', async () => {
		const schema = await freshPhaseOneSchema('over_capacity');
		await seedProjects(schema, [930]);
		const values = Array.from({ length: 6 }, (_, index) => (
			`(${1020 + index}, 930, 'VIDEO', 'READY', 'video-${index}.mp4', CURRENT_TIMESTAMP + interval '${index} second', CURRENT_TIMESTAMP)`
		)).join(', ');
		await control.$executeRawUnsafe(`
			SET search_path TO ${quoted(schema)};
			INSERT INTO "assets" ("id", "project_id", "kind", "status", "original_name", "created_at", "updated_at")
			VALUES ${values}
		`);

		await expect(applyMigration(schema, projectVideoOrderMigration)).rejects.toThrow(
			/project video order expand blocked: 1 projects have more than five READY VIDEO assets/,
		);
		await assertNoVideoOrderColumn(schema);
		expect(await assetCount(schema)).toBe(6n);
	});

	it('keeps the video order column and READY-slot index after the existing Phase 2 contract', async () => {
		const schema = await freshPhaseOneSchema('contract_bridge');
		await applyMigration(schema, projectVideoOrderMigration);
		await applyMigration(schema, canonicalContractMigration);

		const [catalog] = await control.$queryRawUnsafe<Array<{
			columnExists: boolean;
			readyIndex: string | null;
		}>>(`
			SELECT
				EXISTS (SELECT 1 FROM information_schema.columns
					WHERE table_schema = '${schema}' AND table_name = 'assets'
						AND column_name = 'video_sort_order') AS "columnExists",
				pg_get_indexdef(to_regclass('${schema}.asset_project_video_ready_order_unique')) AS "readyIndex"
		`);
		expect(catalog).toMatchObject({
			columnExists: true,
			readyIndex: expect.stringContaining('video_sort_order'),
		});
	});
});
