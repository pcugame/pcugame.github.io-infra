import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';

const runPostgresIntegration = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';
const migrationRootUrl = new URL('../../prisma/migrations/', import.meta.url);
const alternateMigrationUrl = new URL(
	'../../prisma/contract-migration-paths/20260822000002_canonical_asset_contract_image_bridge36/migration.sql',
	import.meta.url,
);
const phaseOneMigration = '20260821800000_project_video_order_expand';
const receiptMigration = '20260821990000_release_exception_receipts';
const alternateMigration = '20260822000002_canonical_asset_contract_image_bridge36';
const sourceSha = 'a'.repeat(40);
const image = `ghcr.io/pcugame/pcu-graduationproject-v2-api@sha256:${'b'.repeat(64)}`;
const legacyMetricNames = [
	'asset_download_legacy_fallback',
	'asset_download_legacy_route',
	'public_image_legacy_bridge',
	'public_image_legacy_fallback',
	'public_webgl_legacy_bridge',
	'public_webgl_legacy_fallback',
	'export_legacy_fallback',
] as const;

function quoted(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

describe.runIf(runPostgresIntegration)('canonical contract image-bridge-36 PostgreSQL path', () => {
	let databaseUrl = '';
	let control: PrismaClient;
	let alternateSql = '';
	const schemas: string[] = [];

	async function freshSchema(label: string): Promise<string> {
		const schema = `contract_bridge36_${label}_${randomUUID().replaceAll('-', '')}`;
		await control.$executeRawUnsafe(`CREATE SCHEMA ${quoted(schema)}`);
		schemas.push(schema);
		return schema;
	}

	async function executeInSchema(schema: string, sql: string): Promise<void> {
		const connection = createPrismaClientForDatabase(databaseUrl);
		try {
			await connection.$connect();
			await connection.$executeRawUnsafe(`SET search_path TO ${quoted(schema)};\n${sql}`);
		} finally {
			await connection.$disconnect();
		}
	}

	async function applyPhaseOneAndReceipts(schema: string): Promise<void> {
		const directories = (await readdir(migrationRootUrl, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory() && entry.name <= phaseOneMigration)
			.map((entry) => entry.name)
			.sort();
		for (const directory of directories) {
			await executeInSchema(schema, await readFile(new URL(`${directory}/migration.sql`, migrationRootUrl), 'utf8'));
		}
		for (const name of [receiptMigration, '20260821991000_release_image_bridge_exception']) {
			await executeInSchema(schema, await readFile(new URL(`${name}/migration.sql`, migrationRootUrl), 'utf8'));
		}
	}

	async function applyAlternateContract(schema: string): Promise<void> {
		await executeInSchema(schema, alternateSql);
	}

	async function seedMetricRows(
		schema: string,
		observationSql: string,
		options: { omit?: string; nonzero?: string } = {},
	): Promise<void> {
		const rows = legacyMetricNames
			.filter((name) => name !== options.omit)
			.map((name) => `('${name}', ${name === options.nonzero ? 1 : 0}, ${observationSql})`)
			.join(',');
		await control.$executeRawUnsafe(`
			INSERT INTO ${quoted(schema)}."migration_metrics"
				("name", "scope", "value", "last_observed_at", "created_at", "updated_at")
			SELECT metric.name, '', metric.value, metric.observed_at::timestamp(3), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
			FROM (VALUES ${rows}) AS metric(name, value, observed_at)
		`);
	}

	async function seedAuthorization(schema: string, expiresAt = 'CURRENT_TIMESTAMP + INTERVAL \'30 minutes\''): Promise<void> {
		const checksum = createHash('sha256').update(alternateSql).digest('hex');
		await control.$executeRawUnsafe(`
			INSERT INTO ${quoted(schema)}."release_contract_authorizations"
				("migration_name", "exception_id", "actor", "run_id", "scope", "source_sha", "image", "migration_checksum", "authorized_at", "expires_at")
			VALUES (
				'${alternateMigration}', 'AGE-EXCEPTION-1', 'release-bot', '12345',
				'24-hour-observation-age-and-image-bridge-36', '${sourceSha}', '${image}', '${checksum}',
				CURRENT_TIMESTAMP - INTERVAL '1 minute', ${expiresAt}
			)
		`);
	}

	async function assertFailureWasAtomic(schema: string): Promise<void> {
		const [state] = await control.$queryRawUnsafe<Array<{
			legacyColumn: boolean;
			metricsTable: boolean;
			receipts: bigint;
			consumed: bigint;
		}>>(`
			SELECT
				EXISTS (SELECT 1 FROM information_schema.columns
					WHERE table_schema = '${schema}' AND table_name = 'assets' AND column_name = 'storage_key') AS "legacyColumn",
				to_regclass('${schema}.migration_metrics') IS NOT NULL AS "metricsTable",
				(SELECT count(*) FROM ${quoted(schema)}."release_contract_exception_receipts") AS "receipts",
				(SELECT count(*) FROM ${quoted(schema)}."release_contract_authorizations" WHERE "consumed_at" IS NOT NULL) AS "consumed"
		`);
		expect(state).toEqual({ legacyColumn: true, metricsTable: true, receipts: 0n, consumed: 0n });
	}

	beforeAll(async () => {
		databaseUrl = process.env['DATABASE_URL'] ?? '';
		if (!databaseUrl) throw new Error('DATABASE_URL is required for PostgreSQL integration tests');
		alternateSql = await readFile(alternateMigrationUrl, 'utf8');
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

	async function fixture(label: string) {
		const schema = await freshSchema(label);
		await applyPhaseOneAndReceipts(schema);
		await seedMetricRows(schema, 'CURRENT_TIMESTAMP');
		await control.$executeRawUnsafe(`UPDATE ${quoted(schema)}."migration_metrics"
		  SET "scope"='api-route', "value"=36, "last_observed_at"=TIMESTAMP '2026-09-09T10:37:52.913',
		      "details"='{"usedLegacyLookup":false,"assetId":123}'::jsonb
		  WHERE "name"='public_image_legacy_bridge'`);
		await seedAuthorization(schema);
		return schema;
	}
	it('applies the real bridge path and retains unmodified metrics and release provenance', async () => {
		const schema = await fixture('valid');
		await applyAlternateContract(schema);
		const [receipt] = await control.$queryRawUnsafe<Array<{ migration_name: string; metrics: Array<Record<string, unknown>>; applied_at: Date }>>(
			`SELECT * FROM ${quoted(schema)}."release_contract_exception_receipts"`);
		expect(receipt?.migration_name).toBe(alternateMigration);
		expect(receipt?.applied_at).toBeInstanceOf(Date);
		expect(receipt?.metrics.find((row) => row['name'] === 'public_image_legacy_bridge')).toMatchObject({
			value: 36, scope: 'api-route', details: { usedLegacyLookup: false, assetId: 123 },
		});
	});
	it.each([
		['value35', `UPDATE migration_metrics SET value=35 WHERE name='public_image_legacy_bridge'`],
		['value37', `UPDATE migration_metrics SET value=37 WHERE name='public_image_legacy_bridge'`],
		['zero', `UPDATE migration_metrics SET value=0 WHERE name='public_image_legacy_bridge'`],
		['scope', `UPDATE migration_metrics SET scope='other' WHERE name='public_image_legacy_bridge'`],
		['date', `UPDATE migration_metrics SET last_observed_at=last_observed_at + INTERVAL '1 millisecond' WHERE name='public_image_legacy_bridge'`],
		['lookup', `UPDATE migration_metrics SET details='{"usedLegacyLookup":true}'::jsonb WHERE name='public_image_legacy_bridge'`],
		['stringfalse', `UPDATE migration_metrics SET details='{"usedLegacyLookup":"false"}'::jsonb WHERE name='public_image_legacy_bridge'`],
		['detailsnull', `UPDATE migration_metrics SET details=NULL WHERE name='public_image_legacy_bridge'`],
		['missing', `DELETE FROM migration_metrics WHERE name='export_legacy_fallback'`],
		['nulltime', `UPDATE migration_metrics SET last_observed_at=NULL WHERE name='export_legacy_fallback'`],
		['infinite', `UPDATE migration_metrics SET last_observed_at='-infinity' WHERE name='export_legacy_fallback'`],
		['future', `UPDATE migration_metrics SET last_observed_at=CURRENT_TIMESTAMP + INTERVAL '1 hour' WHERE name='export_legacy_fallback'`],
		['other', `UPDATE migration_metrics SET value=1 WHERE name='export_legacy_fallback'`],
		['unknown', `INSERT INTO migration_metrics(name,scope,value,updated_at) VALUES('unknown-producer','',1,CURRENT_TIMESTAMP)`],
		['expired', `UPDATE release_contract_authorizations SET expires_at=CURRENT_TIMESTAMP - INTERVAL '1 second'`],
	])('rejects %s drift atomically', async (name, sql) => {
		const schema = await fixture(name);
		await executeInSchema(schema, sql);
		await expect(applyAlternateContract(schema)).rejects.toThrow();
		await assertFailureWasAtomic(schema);
	});
});
