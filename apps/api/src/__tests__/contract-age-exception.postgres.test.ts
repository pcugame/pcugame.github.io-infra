import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';

const runPostgresIntegration = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';
const migrationRootUrl = new URL('../../prisma/migrations/', import.meta.url);
const alternateMigrationUrl = new URL(
	'../../prisma/contract-migration-paths/20260822000001_canonical_asset_contract_age_exception/migration.sql',
	import.meta.url,
);
const phaseOneMigration = '20260821800000_project_video_order_expand';
const receiptMigration = '20260821990000_release_exception_receipts';
const originalContractMigration = '20260822000000_canonical_asset_contract';
const alternateMigration = '20260822000001_canonical_asset_contract_age_exception';
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

describe.runIf(runPostgresIntegration)('canonical contract age-exception PostgreSQL path', () => {
	let databaseUrl = '';
	let control: PrismaClient;
	let alternateSql = '';
	const schemas: string[] = [];

	async function freshSchema(label: string): Promise<string> {
		const schema = `contract_age_exception_${label}_${randomUUID().replaceAll('-', '')}`;
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
		await executeInSchema(
			schema,
			await readFile(new URL(`${receiptMigration}/migration.sql`, migrationRootUrl), 'utf8'),
		);
	}

	async function applyOriginalContract(schema: string): Promise<void> {
		await executeInSchema(
			schema,
			await readFile(new URL(`${originalContractMigration}/migration.sql`, migrationRootUrl), 'utf8'),
		);
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

	async function seedBusinessUser(schema: string, label: string): Promise<void> {
		await control.$executeRawUnsafe(`
			INSERT INTO ${quoted(schema)}."users" ("google_sub", "email", "name", "picture", "created_at", "updated_at")
			VALUES ('age-exception-${label}', '${label}@example.test', 'Age exception ${label}', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		`);
	}

	async function seedAuthorization(schema: string, expiresAt = 'CURRENT_TIMESTAMP + INTERVAL \'30 minutes\''): Promise<void> {
		const checksum = createHash('sha256').update(alternateSql).digest('hex');
		await control.$executeRawUnsafe(`
			INSERT INTO ${quoted(schema)}."release_contract_authorizations"
				("migration_name", "exception_id", "actor", "run_id", "scope", "source_sha", "image", "migration_checksum", "authorized_at", "expires_at")
			VALUES (
				'${alternateMigration}', 'AGE-EXCEPTION-1', 'release-bot', '12345',
				'24-hour-observation-age-only', '${sourceSha}', '${image}', '${checksum}',
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

	it('leaves the normal contract migration age-gated and independent of the additive receipt schema', async () => {
		const schema = await freshSchema('normal');
		await applyPhaseOneAndReceipts(schema);
		await seedBusinessUser(schema, 'normal');
		await seedMetricRows(schema, 'CURRENT_TIMESTAMP - INTERVAL \'25 hours\'');

		await applyOriginalContract(schema);

		const [state] = await control.$queryRawUnsafe<Array<{ metricsGone: boolean; receipts: bigint; authorizations: bigint }>>(`
			SELECT
				to_regclass('${schema}.migration_metrics') IS NULL AS "metricsGone",
				(SELECT count(*) FROM ${quoted(schema)}."release_contract_exception_receipts") AS "receipts",
				(SELECT count(*) FROM ${quoted(schema)}."release_contract_authorizations") AS "authorizations"
		`);
		expect(state).toEqual({ metricsGone: true, receipts: 0n, authorizations: 0n });
	});

	it('does not let an alternate authorization relax the normal migration observation window', async () => {
		const schema = await freshSchema('normal_recent');
		await applyPhaseOneAndReceipts(schema);
		await seedBusinessUser(schema, 'normal-recent');
		await seedMetricRows(schema, 'CURRENT_TIMESTAMP');
		await seedAuthorization(schema);

		await expect(applyOriginalContract(schema)).rejects.toThrow(/lack a 24-hour zero observation/);
		await assertFailureWasAtomic(schema);
	});

	it('permits recent zero observations only through a current authorized alternate and keeps its receipt and ledger', async () => {
		const schema = await freshSchema('authorized');
		await applyPhaseOneAndReceipts(schema);
		await seedBusinessUser(schema, 'authorized');
		await seedMetricRows(schema, 'CURRENT_TIMESTAMP');
		await seedAuthorization(schema);

		await applyAlternateContract(schema);

		const [state] = await control.$queryRawUnsafe<Array<{
			metricsGone: boolean;
			receiptMigration: string;
			receiptApplied: boolean;
			receiptMetricRows: number;
			receiptRelocations: bigint;
			receiptSource: string;
			receiptImage: string;
			ledgerConsumed: boolean;
			originalReceiptRows: bigint;
		}>>(`
			SELECT
				to_regclass('${schema}.migration_metrics') IS NULL AS "metricsGone",
				r."migration_name" AS "receiptMigration",
				r."applied_at" IS NOT NULL AS "receiptApplied",
				jsonb_array_length(r."metrics") AS "receiptMetricRows",
				(r."relocation_summary" ->> 'total')::bigint AS "receiptRelocations",
				r."source_sha" AS "receiptSource",
				r."image" AS "receiptImage",
				a."consumed_at" IS NOT NULL AS "ledgerConsumed",
				(SELECT count(*) FROM ${quoted(schema)}."release_contract_exception_receipts"
					WHERE "migration_name" = '${originalContractMigration}') AS "originalReceiptRows"
			FROM ${quoted(schema)}."release_contract_exception_receipts" r
			JOIN ${quoted(schema)}."release_contract_authorizations" a USING ("migration_name")
		`);
		expect(state).toEqual({
			metricsGone: true,
			receiptMigration: alternateMigration,
			receiptApplied: true,
			receiptMetricRows: 7,
			receiptRelocations: 0n,
			receiptSource: sourceSha,
			receiptImage: image,
			ledgerConsumed: true,
			originalReceiptRows: 0n,
		});
	});

	it.each([
		['missing', { omit: 'export_legacy_fallback' }, /missing, non-zero, or lack a 24-hour zero observation/],
		['non-zero', { nonzero: 'public_image_legacy_fallback' }, /non-zero legacy fallback metric rows/],
		['null timestamp', {}, /missing, non-zero, or lack a 24-hour zero observation/],
		['future timestamp', {}, /missing, non-zero, or lack a 24-hour zero observation/],
		['infinite timestamp', {}, /missing, non-zero, or lack a 24-hour zero observation/],
	] as const)('rejects %s metric evidence atomically even with an authorization', async (kind, options, message) => {
		const schema = await freshSchema(`invalid_${kind.replaceAll(' ', '_')}`);
		await applyPhaseOneAndReceipts(schema);
		const observation = kind === 'null timestamp'
			? 'NULL'
			: kind === 'future timestamp'
				? 'CURRENT_TIMESTAMP + INTERVAL \'1 minute\''
				: kind === 'infinite timestamp' ? "'-infinity'" : 'CURRENT_TIMESTAMP';
		await seedMetricRows(schema, observation, options);
		await seedAuthorization(schema);

		await expect(applyAlternateContract(schema)).rejects.toThrow(message);
		await assertFailureWasAtomic(schema);
	});

	it.each(['missing', 'expired'] as const)('rejects recent otherwise-zero metrics with a %s authorization', async (kind) => {
		const schema = await freshSchema(`${kind}_authorization`);
		await applyPhaseOneAndReceipts(schema);
		await seedMetricRows(schema, 'CURRENT_TIMESTAMP');
		if (kind === 'expired') await seedAuthorization(schema, 'CURRENT_TIMESTAMP - INTERVAL \'1 second\'');

		await expect(applyAlternateContract(schema)).rejects.toThrow(/lacks a current explicit release authorization/);
		await assertFailureWasAtomic(schema);
	});
});
