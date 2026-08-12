import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';

const runPostgresIntegration = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';
const migrationRootUrl = new URL('../../prisma/migrations/', import.meta.url);
const foundationMigrationUrl = new URL(
	'../../prisma/migrations/20260812000000_responsive_image_foundation/migration.sql',
	import.meta.url,
);
const deterministicMigrationUrl = new URL(
	'../../prisma/migrations/20260812010000_deterministic_responsive_images/migration.sql',
	import.meta.url,
);
const reservedCardSuffix = '/__pcu_image_rendition__/v1/card-480.webp';

describe.runIf(runPostgresIntegration)('responsive image migrations with PostgreSQL', () => {
	let databaseUrl: string;
	let control: PrismaClient;
	let foundationMigration: string;
	let deterministicMigration: string;
	let checkedInMigrations: string[];
	const schemas = new Set<string>();

	function quotedIdentifier(identifier: string): string {
		return `"${identifier.replaceAll('"', '""')}"`;
	}

	async function createEmptySchema(): Promise<string> {
		const schema = `responsive_migration_${randomUUID().replaceAll('-', '')}`;
		const quotedSchema = quotedIdentifier(schema);
		schemas.add(schema);
		await control.$executeRawUnsafe(`CREATE SCHEMA ${quotedSchema}`);
		return schema;
	}

	async function createFixture(): Promise<string> {
		const schema = await createEmptySchema();
		const quotedSchema = quotedIdentifier(schema);
		await control.$executeRawUnsafe(`
			CREATE TABLE ${quotedSchema}."assets" (
				"id" SERIAL PRIMARY KEY,
				"storage_key" TEXT NOT NULL
			);
			CREATE TABLE ${quotedSchema}."exhibitions" (
				"id" SERIAL PRIMARY KEY,
				"poster_storage_key" TEXT
			)
		`);
		return schema;
	}

	async function runMigration(
		schema: string,
		migration: string,
		options: { sessionDefaultIsolation?: 'repeatable read' | 'serializable' } = {},
	): Promise<void> {
		const connection = createPrismaClientForDatabase(databaseUrl);
		const isolation = options.sessionDefaultIsolation
			? `SET default_transaction_isolation TO '${options.sessionDefaultIsolation}';\n`
			: '';
		const scopedMigration = `${isolation}SET search_path TO ${quotedIdentifier(schema)};\n${migration}`;
		try {
			await connection.$connect();
			await connection.$executeRawUnsafe(scopedMigration);
		} finally {
			// Closing the dedicated connection also rolls back the deliberately
			// aborted transaction used by failure-path tests.
			await connection.$disconnect();
		}
	}

	async function featureColumns(schema: string): Promise<string[]> {
		const rows = await control.$queryRawUnsafe<Array<{ column_name: string }>>(`
			SELECT column_name
			FROM information_schema.columns
			WHERE table_schema = '${schema}'
				AND column_name IN (
					'width',
					'height',
					'poster_width',
					'poster_height',
					'card_480_height',
					'display_960_height',
					'poster_card_480_height',
					'poster_display_960_height'
				)
			ORDER BY column_name
		`);
		return rows.map(({ column_name }) => column_name);
	}

	async function featureConstraints(schema: string): Promise<string[]> {
		const rows = await control.$queryRawUnsafe<Array<{ constraint_name: string }>>(`
			SELECT constraint_name
			FROM information_schema.table_constraints
			WHERE constraint_schema = '${schema}'
				AND constraint_name IN (
					'assets_storage_key_not_deterministic_rendition_check',
					'exhibitions_poster_key_not_deterministic_rendition_check'
				)
			ORDER BY constraint_name
		`);
		return rows.map(({ constraint_name }) => constraint_name);
	}

	async function renditionCatalog(schema: string): Promise<{
		tableExists: boolean;
		typeExists: boolean;
	}> {
		const [table] = await control.$queryRawUnsafe<Array<{ exists: boolean }>>(`
			SELECT EXISTS (
				SELECT 1
				FROM information_schema.tables
				WHERE table_schema = '${schema}' AND table_name = 'image_renditions'
			) AS "exists"
		`);
		const [type] = await control.$queryRawUnsafe<Array<{ exists: boolean }>>(`
			SELECT EXISTS (
				SELECT 1
				FROM pg_type
				JOIN pg_namespace ON pg_namespace.oid = pg_type.typnamespace
				WHERE pg_namespace.nspname = '${schema}'
					AND pg_type.typname = 'ImageRenditionProfile'
			) AS "exists"
		`);
		return {
			tableExists: table?.exists ?? false,
			typeExists: type?.exists ?? false,
		};
	}

	async function createLegacyRenditionInventory(schema: string): Promise<void> {
		const quotedSchema = quotedIdentifier(schema);
		await control.$executeRawUnsafe(`
			CREATE TYPE ${quotedSchema}."ImageRenditionProfile" AS ENUM ('CARD_480', 'DISPLAY_960');
			CREATE TABLE ${quotedSchema}."image_renditions" (
				"id" SERIAL PRIMARY KEY,
				"profile" ${quotedSchema}."ImageRenditionProfile" NOT NULL,
				"storage_key" TEXT NOT NULL
			)
		`);
	}

	async function waitForRelationLock(
		schema: string,
		table: string,
		mode: 'AccessExclusiveLock' | 'RowExclusiveLock',
		granted: boolean,
	): Promise<void> {
		for (let attempt = 0; attempt < 300; attempt += 1) {
			const [lock] = await control.$queryRawUnsafe<Array<{ exists: boolean }>>(`
				SELECT EXISTS (
					SELECT 1
					FROM pg_locks
					JOIN pg_class ON pg_class.oid = pg_locks.relation
					JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
					WHERE pg_namespace.nspname = '${schema}'
						AND pg_class.relname = '${table}'
						AND pg_locks.mode = '${mode}'
						AND pg_locks.granted = ${granted}
				) AS "exists"
			`);
			if (lock?.exists) return;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error(
			`Timed out waiting for ${granted ? 'granted' : 'waiting'} ${mode} on ${schema}.${table}`,
		);
	}

	beforeAll(async () => {
		databaseUrl = process.env['DATABASE_URL'] ?? '';
		if (!databaseUrl) {
			throw new Error('DATABASE_URL is required for PostgreSQL integration tests');
		}
		const migrationDirectories = (await readdir(migrationRootUrl, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
		[foundationMigration, deterministicMigration, checkedInMigrations] = await Promise.all([
			readFile(foundationMigrationUrl, 'utf8'),
			readFile(deterministicMigrationUrl, 'utf8'),
			Promise.all(migrationDirectories.map((directory) => readFile(
				new URL(`${directory}/migration.sql`, migrationRootUrl),
				'utf8',
			))),
		]);
		control = createPrismaClientForDatabase(databaseUrl);
		await control.$connect();
	});

	afterAll(async () => {
		if (!control) return;
		for (const schema of schemas) {
			await control.$executeRawUnsafe(
				`DROP SCHEMA IF EXISTS ${quotedIdentifier(schema)} CASCADE`,
			).catch(() => undefined);
		}
		await control.$disconnect();
	});

	it('applies the complete checked-in fresh path without creating a rendition model', async () => {
		const schema = await createEmptySchema();

		for (const migration of checkedInMigrations) {
			await runMigration(schema, migration);
		}

		expect(await featureColumns(schema)).toEqual([
			'card_480_height',
			'display_960_height',
			'height',
			'poster_card_480_height',
			'poster_display_960_height',
			'poster_height',
			'poster_width',
			'width',
		]);
		expect(await renditionCatalog(schema)).toEqual({
			tableExists: false,
			typeExists: false,
		});
	});

	it('applies the production-pristine relevant state without creating a rendition model', async () => {
		const schema = await createFixture();
		const quotedSchema = quotedIdentifier(schema);
		await control.$executeRawUnsafe(`
			INSERT INTO ${quotedSchema}."assets" ("storage_key") VALUES ('canonical/original.webp');
			INSERT INTO ${quotedSchema}."exhibitions" ("poster_storage_key") VALUES (NULL)
		`);

		await runMigration(schema, foundationMigration);
		await runMigration(schema, deterministicMigration);

		expect(await featureColumns(schema)).toEqual([
			'card_480_height',
			'display_960_height',
			'height',
			'poster_card_480_height',
			'poster_display_960_height',
			'poster_height',
			'poster_width',
			'width',
		]);
		expect(await featureConstraints(schema)).toEqual([
			'assets_storage_key_not_deterministic_rendition_check',
			'exhibitions_poster_key_not_deterministic_rendition_check',
		]);
		expect(await renditionCatalog(schema)).toEqual({
			tableExists: false,
			typeExists: false,
		});
		await expect(control.$queryRawUnsafe(
			`SELECT "storage_key" FROM ${quotedSchema}."assets"`,
		)).resolves.toEqual([{ storage_key: 'canonical/original.webp' }]);
	});

	it('rolls back the whole foundation migration when the second owner alteration fails', async () => {
		const schema = await createFixture();
		const quotedSchema = quotedIdentifier(schema);
		await control.$executeRawUnsafe(
			`ALTER TABLE ${quotedSchema}."exhibitions" ADD COLUMN "poster_width" INTEGER`,
		);

		await expect(runMigration(schema, foundationMigration)).rejects.toThrow();

		expect(await featureColumns(schema)).toEqual(['poster_width']);
	});

	it('removes an empty legacy inventory only after the owner schema succeeds', async () => {
		const schema = await createFixture();
		await runMigration(schema, foundationMigration);
		await createLegacyRenditionInventory(schema);

		await runMigration(schema, deterministicMigration);

		expect(await featureColumns(schema)).toContain('card_480_height');
		expect(await featureConstraints(schema)).toHaveLength(2);
		expect(await renditionCatalog(schema)).toEqual({
			tableExists: false,
			typeExists: false,
		});
	});

	it('holds the inventory lock from precheck through drop against a concurrent legacy insert', async () => {
		const schema = await createFixture();
		const quotedSchema = quotedIdentifier(schema);
		await runMigration(schema, foundationMigration);
		await createLegacyRenditionInventory(schema);

		const blocker = createPrismaClientForDatabase(databaseUrl);
		const writer = createPrismaClientForDatabase(databaseUrl);
		let releaseAssetLock: () => void = () => {};
		const assetLockRelease = new Promise<void>((resolve) => {
			releaseAssetLock = resolve;
		});
		let reportAssetLockReady: () => void = () => {};
		const assetLockReady = new Promise<void>((resolve) => {
			reportAssetLockReady = resolve;
		});
		let blockerTransaction: Promise<unknown> | undefined;
		let migrationOutcome: Promise<{ ok: boolean; error?: unknown }> | undefined;
		let writerOutcome: Promise<{ ok: boolean; error?: unknown }> | undefined;
		try {
			await Promise.all([blocker.$connect(), writer.$connect()]);
			blockerTransaction = blocker.$transaction(async (tx) => {
				await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '10s'");
				await tx.$executeRawUnsafe(
					`LOCK TABLE ${quotedSchema}."assets" IN ACCESS SHARE MODE`,
				);
				reportAssetLockReady();
				await assetLockRelease;
			});
			await assetLockReady;

			migrationOutcome = runMigration(schema, deterministicMigration).then(
				() => ({ ok: true }),
				(error: unknown) => ({ ok: false, error }),
			);
			// Reaching the blocked assets ALTER proves that the inventory lock and
			// empty precheck have already completed in the migration transaction.
			await waitForRelationLock(schema, 'assets', 'AccessExclusiveLock', false);
			await waitForRelationLock(
				schema,
				'image_renditions',
				'AccessExclusiveLock',
				true,
			);

			const storageKey = `concurrent-generation.webp${reservedCardSuffix}`;
			writerOutcome = writer.$executeRawUnsafe(`
				SET lock_timeout = '5s';
				SET statement_timeout = '10s';
				INSERT INTO ${quotedSchema}."image_renditions" ("profile", "storage_key")
				VALUES ('CARD_480', '${storageKey}')
			`).then(
				() => ({ ok: true }),
				(error: unknown) => ({ ok: false, error }),
			);
			await waitForRelationLock(
				schema,
				'image_renditions',
				'RowExclusiveLock',
				false,
			);
			expect(await Promise.race([
				writerOutcome.then(() => 'settled'),
				new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 50)),
			])).toBe('blocked');

			releaseAssetLock();
			await blockerTransaction;
			const [migrationResult, writerResult] = await Promise.all([
				migrationOutcome,
				writerOutcome,
			]);
			expect(migrationResult).toEqual({ ok: true });
			expect(writerResult.ok).toBe(false);
			expect(String(writerResult.error)).toMatch(/image_renditions|relation|catalog/i);
			expect(await renditionCatalog(schema)).toEqual({
				tableExists: false,
				typeExists: false,
			});
		} finally {
			releaseAssetLock();
			await Promise.allSettled([
				blockerTransaction,
				migrationOutcome,
				writerOutcome,
			]);
			await Promise.all([blocker.$disconnect(), writer.$disconnect()]);
		}
	});

	it('sees a writer commit after lock wait despite a repeatable-read session default', async () => {
		const schema = await createFixture();
		const quotedSchema = quotedIdentifier(schema);
		await runMigration(schema, foundationMigration);
		await createLegacyRenditionInventory(schema);

		const writer = createPrismaClientForDatabase(databaseUrl);
		let commitWriter: () => void = () => {};
		const writerCommit = new Promise<void>((resolve) => {
			commitWriter = resolve;
		});
		let reportWriterReady: () => void = () => {};
		const writerReady = new Promise<void>((resolve) => {
			reportWriterReady = resolve;
		});
		let writerTransaction: Promise<unknown> | undefined;
		let migrationOutcome: Promise<{ ok: boolean; error?: unknown }> | undefined;
		const storageKey = `repeatable-read-generation.webp${reservedCardSuffix}`;
		try {
			await writer.$connect();
			writerTransaction = writer.$transaction(async (tx) => {
				await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '10s'");
				await tx.$executeRawUnsafe(`
					INSERT INTO ${quotedSchema}."image_renditions" ("profile", "storage_key")
					VALUES ('CARD_480', '${storageKey}')
				`);
				reportWriterReady();
				await writerCommit;
			});
			await writerReady;

			migrationOutcome = runMigration(schema, deterministicMigration, {
				sessionDefaultIsolation: 'repeatable read',
			}).then(
				() => ({ ok: true }),
				(error: unknown) => ({ ok: false, error }),
			);
			await waitForRelationLock(
				schema,
				'image_renditions',
				'AccessExclusiveLock',
				false,
			);

			commitWriter();
			await writerTransaction;
			const migrationResult = await migrationOutcome;
			expect(migrationResult.ok).toBe(false);
			expect(String(migrationResult.error)).toMatch(
				/Cannot remove non-empty image_renditions/,
			);
			expect(await featureColumns(schema)).toEqual([
				'height',
				'poster_height',
				'poster_width',
				'width',
			]);
			expect(await featureConstraints(schema)).toEqual([]);
			expect(await renditionCatalog(schema)).toEqual({
				tableExists: true,
				typeExists: true,
			});
			await expect(control.$queryRawUnsafe(
				`SELECT "storage_key" FROM ${quotedSchema}."image_renditions"`,
			)).resolves.toEqual([{ storage_key: storageKey }]);
		} finally {
			commitWriter();
			await Promise.allSettled([writerTransaction, migrationOutcome]);
			await writer.$disconnect();
		}
	});

	it('fails without partial DDL under an unsupported repeatable-read outer transaction', async () => {
		const schema = await createFixture();
		await runMigration(schema, foundationMigration);
		await createLegacyRenditionInventory(schema);
		const connection = createPrismaClientForDatabase(databaseUrl);
		try {
			await connection.$connect();
			await expect(connection.$transaction(async (tx) => {
				await tx.$executeRawUnsafe(
					'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
				);
				await tx.$executeRawUnsafe(
					`SET LOCAL search_path TO ${quotedIdentifier(schema)}`,
				);
				await tx.$queryRawUnsafe('SELECT 1');
				await tx.$executeRawUnsafe(deterministicMigration);
			})).rejects.toThrow(/requires READ COMMITTED isolation|isolation level/i);
		} finally {
			await connection.$disconnect();
		}

		expect(await featureColumns(schema)).toEqual([
			'height',
			'poster_height',
			'poster_width',
			'width',
		]);
		expect(await featureConstraints(schema)).toEqual([]);
		expect(await renditionCatalog(schema)).toEqual({
			tableExists: true,
			typeExists: true,
		});
	});

	it('fails before schema changes and preserves a durable rendition reference', async () => {
		const schema = await createFixture();
		const quotedSchema = quotedIdentifier(schema);
		await runMigration(schema, foundationMigration);
		await createLegacyRenditionInventory(schema);
		const storageKey = `generation.webp${reservedCardSuffix}`;
		await control.$executeRawUnsafe(`
			INSERT INTO ${quotedSchema}."image_renditions" ("profile", "storage_key")
			VALUES ('CARD_480', '${storageKey}')
		`);

		await expect(runMigration(schema, deterministicMigration)).rejects.toThrow(
			/Cannot remove non-empty image_renditions/,
		);

		expect(await featureColumns(schema)).toEqual([
			'height',
			'poster_height',
			'poster_width',
			'width',
		]);
		expect(await featureConstraints(schema)).toEqual([]);
		expect(await renditionCatalog(schema)).toEqual({ tableExists: true, typeExists: true });
		await expect(control.$queryRawUnsafe(
			`SELECT "storage_key" FROM ${quotedSchema}."image_renditions"`,
		)).resolves.toEqual([{ storage_key: storageKey }]);
	});

	it('rolls back earlier DDL when a later legacy constraint validation fails', async () => {
		const schema = await createFixture();
		const quotedSchema = quotedIdentifier(schema);
		await runMigration(schema, foundationMigration);
		await createLegacyRenditionInventory(schema);
		const conflictingPosterKey = `poster.webp${reservedCardSuffix}`;
		await control.$executeRawUnsafe(`
			INSERT INTO ${quotedSchema}."assets" ("storage_key") VALUES ('valid-original.webp');
			INSERT INTO ${quotedSchema}."exhibitions" ("poster_storage_key")
			VALUES ('${conflictingPosterKey}')
		`);

		await expect(runMigration(schema, deterministicMigration)).rejects.toThrow();

		expect(await featureColumns(schema)).toEqual([
			'height',
			'poster_height',
			'poster_width',
			'width',
		]);
		expect(await featureConstraints(schema)).toEqual([]);
		expect(await renditionCatalog(schema)).toEqual({ tableExists: true, typeExists: true });
		await expect(control.$queryRawUnsafe(
			`SELECT "poster_storage_key" FROM ${quotedSchema}."exhibitions"`,
		)).resolves.toEqual([{ poster_storage_key: conflictingPosterKey }]);
	});
});
