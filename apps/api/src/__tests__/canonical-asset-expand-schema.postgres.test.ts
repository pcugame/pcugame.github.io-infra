import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';

const runPostgresIntegration = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';
const migrationRootUrl = new URL('../../prisma/migrations/', import.meta.url);

describe.runIf(runPostgresIntegration)('canonical asset expand fresh PostgreSQL path', () => {
	let databaseUrl = '';
	let control: PrismaClient;
	let schema = '';

	function quoted(identifier: string): string {
		return `"${identifier.replaceAll('"', '""')}"`;
	}

	beforeAll(async () => {
		databaseUrl = process.env['DATABASE_URL'] ?? '';
		if (!databaseUrl) throw new Error('DATABASE_URL is required for PostgreSQL integration tests');
		control = createPrismaClientForDatabase(databaseUrl);
		await control.$connect();
		schema = `canonical_expand_${randomUUID().replaceAll('-', '')}`;
		await control.$executeRawUnsafe(`CREATE SCHEMA ${quoted(schema)}`);
	});

	afterAll(async () => {
		if (!control) return;
		await control.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${quoted(schema)} CASCADE`).catch(() => undefined);
		await control.$disconnect();
	});

	it('applies every migration and installs the canonical upload fencing catalog', async () => {
		const directories = (await readdir(migrationRootUrl, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
		for (const directory of directories) {
			const sql = await readFile(new URL(`${directory}/migration.sql`, migrationRootUrl), 'utf8');
			const connection = createPrismaClientForDatabase(databaseUrl);
			try {
				await connection.$connect();
				await connection.$executeRawUnsafe(`SET search_path TO ${quoted(schema)};\n${sql}`);
			} finally {
				await connection.$disconnect();
			}
		}

		const [catalog] = await control.$queryRawUnsafe<Array<{
			tableExists: boolean;
			activeIndex: string | null;
			exhibitionActiveIndex: string | null;
			abortFkExists: boolean;
			manifestColumn: boolean;
			ownerCheckExists: boolean;
		}>>(`
			SELECT
				to_regclass('${schema}.asset_upload_sessions') IS NOT NULL AS "tableExists",
				pg_get_indexdef(to_regclass('${schema}.asset_upload_sessions_active_project_kind_key')) AS "activeIndex",
				pg_get_indexdef(to_regclass('${schema}.asset_upload_sessions_active_exhibition_kind_key')) AS "exhibitionActiveIndex",
				EXISTS (
					SELECT 1 FROM information_schema.table_constraints
					WHERE constraint_schema = '${schema}'
						AND table_name = 'multipart_abort_tasks'
						AND constraint_name = 'multipart_abort_tasks_upload_session_id_fkey'
				) AS "abortFkExists",
				EXISTS (
					SELECT 1 FROM information_schema.columns
					WHERE table_schema = '${schema}' AND table_name = 'webgl_deployments'
						AND column_name = 'object_manifest' AND data_type = 'jsonb'
				) AS "manifestColumn",
				EXISTS (
					SELECT 1 FROM information_schema.table_constraints
					WHERE constraint_schema = '${schema}' AND table_name = 'asset_upload_sessions'
						AND constraint_name = 'asset_upload_sessions_owner_xor_check'
				) AS "ownerCheckExists"
		`);
		expect(catalog?.tableExists).toBe(true);
		expect(catalog?.activeIndex).toContain('ALLOCATING');
		expect(catalog?.activeIndex).toContain('VERIFYING');
		expect(catalog?.activeIndex).toContain('project_id IS NOT NULL');
		expect(catalog?.exhibitionActiveIndex).toContain('exhibition_id IS NOT NULL');
		expect(catalog?.abortFkExists).toBe(true);
		expect(catalog?.manifestColumn).toBe(true);
		expect(catalog?.ownerCheckExists).toBe(true);
	});
});
