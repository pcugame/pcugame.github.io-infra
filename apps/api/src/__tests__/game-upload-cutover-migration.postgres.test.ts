import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';
import { createMultipartAbortRepository } from '../modules/multipart-abort/repository.js';
import { createMultipartAbortService } from '../modules/multipart-abort/service.js';
import { createOrphanRepository } from '../modules/orphan/repository.js';
import { runOrphanReaper } from '../modules/orphan/service.js';
import { auditGameUploadCutover } from '../modules/admin/game-upload/cutover-audit.js';

const runPostgresIntegration = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';
const migrationRootUrl = new URL('../../prisma/migrations/', import.meta.url);
const cutoverDirectory = '20260820130000_remove_legacy_game_upload_proxy';
const quotaDirectory = '20260820140000_direct_upload_capability_quotas';
const targetFenceDirectory = '20260820150000_game_upload_expected_target_fence';

describe.runIf(runPostgresIntegration)('legacy game-upload cutover migration', () => {
	let databaseUrl: string;
	let control: PrismaClient;
	let historicalMigrations: string[];
	let cutoverMigration: string;
	let targetFenceMigration: string;
	let throughQuotaMigrations: string[];
	let postCutoverMigrations: string[];
	const schemas = new Set<string>();

	function quotedIdentifier(identifier: string): string {
		return `"${identifier.replaceAll('"', '""')}"`;
	}

	function schemaDatabaseUrl(schema: string): string {
		const parsed = new URL(databaseUrl);
		parsed.searchParams.set('schema', schema);
		// Repository lifecycle queries intentionally use raw, unqualified SQL.
		// Pin every pool connection to the isolated fixture schema as well as
		// configuring Prisma's model namespace.
		parsed.searchParams.set('options', `-c search_path=${schema}`);
		return parsed.toString();
	}

	async function createSchema(): Promise<string> {
		const schema = `game_cutover_${randomUUID().replaceAll('-', '')}`;
		schemas.add(schema);
		await control.$executeRawUnsafe(`CREATE SCHEMA ${quotedIdentifier(schema)}`);
		return schema;
	}

	async function withSchemaClient<T>(
		schema: string,
		action: (client: PrismaClient) => Promise<T>,
	): Promise<T> {
		const client = createPrismaClientForDatabase(schemaDatabaseUrl(schema));
		try {
			await client.$connect();
			return await action(client);
		} finally {
			await client.$disconnect();
		}
	}

	async function executeMigration(schema: string, sql: string): Promise<void> {
		const scoped = `SET search_path TO ${quotedIdentifier(schema)};\n${sql}`;
		await withSchemaClient(schema, (client) => client.$executeRawUnsafe(scoped).then(() => undefined));
	}

	async function createHistoricalSchema(): Promise<string> {
		const schema = await createSchema();
		for (const migration of historicalMigrations) await executeMigration(schema, migration);
		return schema;
	}

	async function createPreTargetFenceSchema(): Promise<string> {
		const schema = await createSchema();
		for (const migration of historicalMigrations) await executeMigration(schema, migration);
		await executeMigration(schema, cutoverMigration);
		for (const migration of throughQuotaMigrations) await executeMigration(schema, migration);
		return schema;
	}

	async function seedOwners(schema: string): Promise<void> {
		const q = quotedIdentifier(schema);
		await control.$executeRawUnsafe(`
			INSERT INTO ${q}."users" ("id", "google_sub", "updated_at")
			VALUES (101, 'cutover-user', clock_timestamp());
			INSERT INTO ${q}."exhibitions" ("id", "year", "title", "updated_at")
			VALUES (201, 2099, 'cutover', clock_timestamp());
			INSERT INTO ${q}."projects" (
				"id", "exhibition_id", "slug", "title", "creator_id", "updated_at"
			) VALUES
				(301, 201, 'cutover-a', 'Cutover A', 101, clock_timestamp()),
				(302, 201, 'cutover-b', 'Cutover B', 101, clock_timestamp()),
				(303, 201, 'cutover-direct', 'Cutover Direct', 101, clock_timestamp()),
				(304, 201, 'cutover-completed', 'Cutover Completed', 101, clock_timestamp());
		`);
	}

	async function seedPreservedFixture(schema: string): Promise<void> {
		await seedOwners(schema);
		const q = quotedIdentifier(schema);
		const webglSource = 'webgl/301/11111111-1111-4111-8111-111111111111/source.zip';
		await control.$executeRawUnsafe(`
			INSERT INTO ${q}."game_upload_sessions" (
				"id", "project_id", "user_id", "upload_kind", "transport",
				"original_name", "total_bytes", "chunk_size_bytes", "total_chunks",
				"source_identity_algorithm", "source_identity",
				"source_identity_block_size_bytes", "source_identity_block_manifest",
				"status", "storage_key", "s3_upload_id", "s3_key",
				"expires_at", "updated_at"
			) VALUES
				(
					'legacy-pending', 301, 101, 'GAME', 'API_CHUNK_PROXY',
					'pending.zip', 5242880, 5242880, 1,
					'SHA256_BLOCK_MANIFEST_V1', repeat('a', 64), 1048576,
					decode(repeat('ab', 160), 'hex'),
					'PENDING', NULL, 'upload-pending', 'legacy/pending.zip',
					clock_timestamp() + interval '1 day', clock_timestamp()
				),
				(
					'legacy-completing', 301, 101, 'WEBGL', 'API_CHUNK_PROXY',
					'webgl.zip', 5242880, 5242880, 1,
					'SHA256_BLOCK_MANIFEST_V1', repeat('b', 64), 1048576,
					decode(repeat('bc', 160), 'hex'),
					'COMPLETING', '${webglSource}', 'upload-completing', '${webglSource}',
					clock_timestamp() + interval '1 day', clock_timestamp()
				),
				(
					'legacy-cancelled-residue', 302, 101, 'GAME', 'API_CHUNK_PROXY',
					'cancelled.zip', 5242880, 5242880, 1,
					NULL, NULL, NULL, NULL,
					'CANCELLED', 'legacy/cancelled-completed-object.zip', NULL, NULL,
					clock_timestamp() + interval '1 day', clock_timestamp()
				),
				(
					'legacy-completed', 304, 101, 'GAME', 'API_CHUNK_PROXY',
					'preserved.zip', 5242880, 5242880, 1,
					NULL, NULL, NULL, NULL,
					'COMPLETED', NULL, NULL, 'ready/preserved.zip',
					clock_timestamp() + interval '1 day', clock_timestamp()
				),
				(
					'direct-live', 303, 101, 'GAME', 'DIRECT_MULTIPART',
					'direct.zip', 5242880, 5242880, 1,
					'SHA256_BLOCK_MANIFEST_V1', repeat('c', 64), 1048576,
					decode(repeat('cd', 160), 'hex'),
					'PENDING', NULL, 'upload-direct', 'direct/live.zip',
					clock_timestamp() + interval '1 day', clock_timestamp()
				);

			INSERT INTO ${q}."assets" (
				"project_id", "kind", "status", "storage_key", "updated_at"
			) VALUES (304, 'GAME', 'READY', 'ready/preserved.zip', clock_timestamp());

			INSERT INTO ${q}."game_upload_active_sessions" (
				"project_id", "upload_kind", "session_id", "updated_at"
			) VALUES
				(301, 'GAME', 'legacy-pending', clock_timestamp()),
				(301, 'WEBGL', 'legacy-completing', clock_timestamp()),
				(304, 'GAME', 'legacy-completed', clock_timestamp()),
				(303, 'GAME', 'direct-live', clock_timestamp());

			INSERT INTO ${q}."game_upload_parts" (
				"session_id", "part_number", "etag", "generation", "updated_at"
			) VALUES
				('legacy-pending', 1, 'legacy-etag', 1, clock_timestamp()),
				('direct-live', 1, 'direct-etag', 1, clock_timestamp());
			INSERT INTO ${q}."game_upload_part_claims" (
				"id", "session_id", "part_number", "token", "generation",
				"lease_until", "updated_at"
			) VALUES (
				'legacy-claim', 'legacy-pending', 1, 'legacy-claim-token', 1,
				clock_timestamp() + interval '1 minute', clock_timestamp()
			);

			INSERT INTO ${q}."multipart_abort_tasks" (
				"id", "bucket", "storage_key", "upload_id", "reason", "state",
				"resolved_at", "updated_at"
			) VALUES (
				'existing-abort', 'pcu-protected', 'legacy/pending.zip',
				'upload-pending', 'old-reason', 'RESOLVED', clock_timestamp(), clock_timestamp()
			);
			INSERT INTO ${q}."orphan_objects" (
				"bucket", "storage_key", "reason", "target_kind", "state", "resolved_at"
			) VALUES (
				'pcu-protected', 'legacy/pending.zip', 'old-reason',
				'EXACT', 'RESOLVED', clock_timestamp()
			);
		`);
	}

	async function seedPreTargetFenceFixture(schema: string): Promise<void> {
		await seedOwners(schema);
		const q = quotedIdentifier(schema);
		const webglSource = 'webgl/303/22222222-2222-4222-8222-222222222222/source.zip';
		await control.$executeRawUnsafe(`
			INSERT INTO ${q}."game_upload_sessions" (
				"id", "project_id", "user_id", "upload_kind", "original_name",
				"total_bytes", "chunk_size_bytes", "total_chunks",
				"source_identity_algorithm", "source_identity",
				"source_identity_block_size_bytes", "source_identity_block_manifest",
				"status", "storage_key", "s3_upload_id", "s3_key",
				"expires_at", "updated_at"
			) VALUES
				(
					'pre-fence-pending', 301, 101, 'GAME', 'pending.zip',
					5242880, 5242880, 1, 'SHA256_BLOCK_MANIFEST_V1', repeat('a', 64),
					1048576, decode(repeat('aa', 160), 'hex'), 'PENDING', NULL,
					'pending-upload-id', 'direct/pending.zip',
					clock_timestamp() + interval '1 day', clock_timestamp()
				),
				(
					'pre-fence-completing', 302, 101, 'GAME', 'completing.zip',
					5242880, 5242880, 1, 'SHA256_BLOCK_MANIFEST_V1', repeat('b', 64),
					1048576, decode(repeat('bb', 160), 'hex'), 'COMPLETING', NULL,
					'completing-upload-id', 'direct/completing.zip',
					clock_timestamp() + interval '1 day', clock_timestamp()
				),
				(
					'pre-fence-verifying', 303, 101, 'WEBGL', 'webgl.zip',
					5242880, 5242880, 1, 'SHA256_BLOCK_MANIFEST_V1', repeat('c', 64),
					1048576, decode(repeat('cc', 160), 'hex'), 'VERIFYING', '${webglSource}',
					NULL, '${webglSource}',
					clock_timestamp() + interval '1 day', clock_timestamp()
				);

			INSERT INTO ${q}."game_upload_active_sessions" (
				"project_id", "upload_kind", "session_id", "updated_at"
			) VALUES
				(301, 'GAME', 'pre-fence-pending', clock_timestamp()),
				(302, 'GAME', 'pre-fence-completing', clock_timestamp()),
				(303, 'WEBGL', 'pre-fence-verifying', clock_timestamp());

			INSERT INTO ${q}."multipart_abort_tasks" (
				"id", "bucket", "storage_key", "upload_id", "reason", "state",
				"resolved_at", "updated_at"
			) VALUES (
				'pre-fence-existing-abort', 'pcu-protected', 'direct/pending.zip',
				'pending-upload-id', 'old-reason', 'RESOLVED', clock_timestamp(), clock_timestamp()
			);
			INSERT INTO ${q}."orphan_objects" (
				"bucket", "storage_key", "reason", "target_kind", "state", "resolved_at"
			) VALUES (
				'pcu-protected', 'direct/pending.zip', 'old-reason',
				'EXACT', 'RESOLVED', clock_timestamp()
			);
		`);
	}

	async function catalog(schema: string): Promise<{
		columns: string[];
		tables: string[];
		hasTransportType: boolean;
	}> {
		const columns = await control.$queryRawUnsafe<Array<{ column_name: string }>>(`
			SELECT "column_name"
			FROM information_schema.columns
			WHERE "table_schema" = '${schema}'
				AND "table_name" = 'game_upload_sessions'
			ORDER BY "column_name"
		`);
		const tables = await control.$queryRawUnsafe<Array<{ table_name: string }>>(`
			SELECT "table_name"
			FROM information_schema.tables
			WHERE "table_schema" = '${schema}'
				AND "table_name" IN ('game_upload_parts', 'game_upload_part_claims')
			ORDER BY "table_name"
		`);
		const [type] = await control.$queryRawUnsafe<Array<{ exists: boolean }>>(`
			SELECT EXISTS (
				SELECT 1 FROM pg_type
				JOIN pg_namespace ON pg_namespace.oid = pg_type.typnamespace
				WHERE pg_namespace.nspname = '${schema}'
					AND pg_type.typname = 'GameUploadTransport'
			) AS "exists"
		`);
		return {
			columns: columns.map((row) => row.column_name),
			tables: tables.map((row) => row.table_name),
			hasTransportType: type?.exists ?? false,
		};
	}

	beforeAll(async () => {
		databaseUrl = process.env['DATABASE_URL'] ?? '';
		if (!databaseUrl) throw new Error('DATABASE_URL is required for PostgreSQL integration tests');
		const directories = (await readdir(migrationRootUrl, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
		const migrations = await Promise.all(directories.map(async (directory) => ({
			directory,
			sql: await readFile(new URL(`${directory}/migration.sql`, migrationRootUrl), 'utf8'),
		})));
		cutoverMigration = migrations.find(({ directory }) => directory === cutoverDirectory)?.sql ?? '';
		if (!cutoverMigration) throw new Error('Cutover migration was not found');
		historicalMigrations = migrations
			.filter(({ directory }) => directory < cutoverDirectory)
			.map(({ sql }) => sql);
		postCutoverMigrations = migrations
			.filter(({ directory }) => directory > cutoverDirectory)
			.map(({ sql }) => sql);
		if (!migrations.some(({ directory }) => directory === quotaDirectory)) {
			throw new Error('Post-cutover quota migration was not found');
		}
		targetFenceMigration = migrations.find(({ directory }) => directory === targetFenceDirectory)?.sql ?? '';
		if (!targetFenceMigration) throw new Error('Target-fence migration was not found');
		throughQuotaMigrations = migrations
			.filter(({ directory }) => directory > cutoverDirectory && directory < targetFenceDirectory)
			.map(({ sql }) => sql);
		expect(migrations.map(({ directory }) => directory).filter((directory) => (
			directory === cutoverDirectory
			|| directory === quotaDirectory
			|| directory === targetFenceDirectory
		))).toEqual([cutoverDirectory, quotaDirectory, targetFenceDirectory]);
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

	it('applies the complete fresh migration history into the direct-only schema', async () => {
		const schema = await createSchema();
		for (const migration of historicalMigrations) await executeMigration(schema, migration);
		await executeMigration(schema, cutoverMigration);
		for (const migration of postCutoverMigrations) await executeMigration(schema, migration);

		const state = await catalog(schema);
		expect(state.tables).toEqual([]);
		expect(state.hasTransportType).toBe(false);
		expect(state.columns).not.toEqual(expect.arrayContaining([
			'transport', 'uploaded_chunks', 'staging_path', 's3_part_etags',
		]));
		expect(state.columns).toEqual(expect.arrayContaining([
			's3_key', 's3_upload_id', 'storage_key', 'multipart_generation',
			'part_url_issue_window_count', 'part_url_issue_window_started_at',
			'part_url_last_issued_at', 'expected_target_asset_id',
			'expected_target_asset_updated_at',
		]));
	}, 120_000);

	it('terminalizes preserved legacy rows, records exact cleanup idempotently, and cleanup workers consume it', async () => {
		const schema = await createHistoricalSchema();
		await seedPreservedFixture(schema);
		const auditProcess = spawnSync(
			process.platform === 'win32' ? 'npm.cmd' : 'npm',
			['exec', '--', 'tsx', 'scripts/audit-game-upload-cutover.ts'],
			{
				cwd: process.cwd(),
				encoding: 'utf8',
				env: {
					...process.env,
					DATABASE_URL: schemaDatabaseUrl(schema),
					S3_BUCKET_PUBLIC: 'pcu-public',
					S3_BUCKET_PROTECTED: 'pcu-protected',
				},
			},
		);
		expect(auditProcess.status, auditProcess.stderr).toBe(0);
		expect(auditProcess.stdout.startsWith('{')).toBe(true);
		const audit = JSON.parse(auditProcess.stdout) as {
			blockers: unknown[];
			legacySessions: Record<string, unknown>;
			legacyRowsRemoved: Record<string, unknown>;
			existingOutbox: Record<string, unknown>;
		};
		expect(audit.blockers).toEqual([]);
		expect(audit.legacySessions).toMatchObject({
			total: 4, nonterminal: 2, cleanupCandidates: 3,
			activeSlots: 3, terminalActiveSlots: 1,
		});
		expect(audit.legacyRowsRemoved).toEqual({ gameUploadParts: 2, gameUploadPartClaims: 1 });
		expect(audit.existingOutbox).toMatchObject({
			matchingMultipartAbortTasks: 1,
			matchingOrphanDeletionTasks: 1,
		});

		await executeMigration(schema, cutoverMigration);
		for (const migration of postCutoverMigrations) await executeMigration(schema, migration);
		const postCutoverCatalog = await catalog(schema);
		expect(postCutoverCatalog.tables).toEqual([]);
		expect(postCutoverCatalog.hasTransportType).toBe(false);
		expect(postCutoverCatalog.columns).toEqual(expect.arrayContaining([
			'part_url_issue_window_count', 'part_url_issue_window_started_at',
			'part_url_last_issued_at',
		]));
		const q = quotedIdentifier(schema);
		const sessions = await control.$queryRawUnsafe<Array<{
			id: string;
			status: string;
			storageKey: string | null;
			s3Key: string | null;
			s3UploadId: string | null;
		}>>(`
			SELECT "id", "status", "storage_key" AS "storageKey",
				"s3_key" AS "s3Key", "s3_upload_id" AS "s3UploadId"
			FROM ${q}."game_upload_sessions" ORDER BY "id"
		`);
		for (const id of ['legacy-pending', 'legacy-completing', 'legacy-cancelled-residue']) {
			expect(sessions.find((session) => session.id === id)).toMatchObject({
				status: 'FAILED', storageKey: null, s3Key: null, s3UploadId: null,
			});
		}
		expect(sessions.find(({ id }) => id === 'legacy-completed')).toMatchObject({
			status: 'COMPLETED', storageKey: 'ready/preserved.zip',
		});
		expect(sessions.find(({ id }) => id === 'direct-live')).toMatchObject({
			status: 'REJECTED', storageKey: 'direct/live.zip', s3Key: null, s3UploadId: null,
		});

		const active = await control.$queryRawUnsafe<Array<{ session_id: string }>>(`
			SELECT "session_id" FROM ${q}."game_upload_active_sessions" ORDER BY "session_id"
		`);
		expect(active).toEqual([]);
		const aborts = await control.$queryRawUnsafe<Array<{
			storage_key: string;
			target_state: string;
		}>>(`
			SELECT "storage_key", "state"::text AS "target_state"
			FROM ${q}."multipart_abort_tasks" ORDER BY "storage_key"
		`);
		expect(aborts).toEqual([
			{ storage_key: 'direct/live.zip', target_state: 'PENDING' },
			{ storage_key: 'legacy/pending.zip', target_state: 'PENDING' },
			{
				storage_key: 'webgl/301/11111111-1111-4111-8111-111111111111/source.zip',
				target_state: 'PENDING',
			},
		]);
		const orphans = await control.$queryRawUnsafe<Array<{
			bucket: string;
			storage_key: string;
			target_kind: string;
			state: string;
		}>>(`
			SELECT "bucket", "storage_key", "target_kind"::text, "state"::text
			FROM ${q}."orphan_objects" ORDER BY "bucket", "storage_key"
		`);
		expect(orphans).toEqual([
			{
				bucket: 'pcu-protected', storage_key: 'direct/live.zip',
				target_kind: 'EXACT', state: 'PENDING',
			},
			{
				bucket: 'pcu-protected', storage_key: 'legacy/cancelled-completed-object.zip',
				target_kind: 'EXACT', state: 'PENDING',
			},
			{
				bucket: 'pcu-protected', storage_key: 'legacy/pending.zip',
				target_kind: 'EXACT', state: 'PENDING',
			},
			{
				bucket: 'pcu-protected',
				storage_key: 'webgl/301/11111111-1111-4111-8111-111111111111/source.zip',
				target_kind: 'EXACT', state: 'PENDING',
			},
			{
				bucket: 'pcu-public',
				storage_key: 'webgl/301/11111111-1111-4111-8111-111111111111/site/',
				target_kind: 'PREFIX', state: 'PENDING',
			},
		]);

		await withSchemaClient(schema, async (client) => {
			const abortMultipart = vi.fn(async () => undefined);
			const abortWorker = createMultipartAbortService({
				repository: createMultipartAbortRepository(client),
				storage: { abortMultipart },
				clock: { now: () => new Date() },
				ids: { next: () => 'migration-abort-worker' },
				logger: { error: vi.fn() },
			});
			expect(await abortWorker.run()).toEqual({ tried: 3, resolved: 3, failed: 0 });
			expect(await abortWorker.run()).toEqual({ tried: 0, resolved: 0, failed: 0 });
			expect(abortMultipart).toHaveBeenCalledTimes(3);

			const deleteObject = vi.fn(async () => undefined);
			const deletionWorker = {
				clock: { now: () => new Date() },
				storage: {
					delete: deleteObject,
					listKeyPage: vi.fn(async () => ({ keys: [], isTruncated: false })),
					deleteKeys: vi.fn(async () => ({ deleted: [], failures: [] })),
				},
				repository: createOrphanRepository(client),
				references: { collect: async () => ({ references: [], unsafeBuckets: new Set<string>() }) },
				ids: { next: () => 'migration-deletion-worker' },
				logger: { info: vi.fn(), error: vi.fn() },
			};
			expect(await runOrphanReaper(deletionWorker)).toEqual({ tried: 5, resolved: 5, failed: 0 });
			expect(await runOrphanReaper(deletionWorker)).toEqual({ tried: 0, resolved: 0, failed: 0 });
			expect(deleteObject).toHaveBeenCalledTimes(4);
		});
	}, 120_000);

	it('blocks custom cleanup buckets for pre-fence direct rows even when no legacy session exists', async () => {
		const schema = await createHistoricalSchema();
		await seedOwners(schema);
		const q = quotedIdentifier(schema);
		const webglSource = 'webgl/302/33333333-3333-4333-8333-333333333333/source.zip';
		await control.$executeRawUnsafe(`
			INSERT INTO ${q}."game_upload_sessions" (
				"id", "project_id", "user_id", "upload_kind", "transport",
				"original_name", "total_bytes", "chunk_size_bytes", "total_chunks",
				"source_identity_algorithm", "source_identity",
				"source_identity_block_size_bytes", "source_identity_block_manifest",
				"status", "storage_key", "s3_upload_id", "s3_key",
				"expires_at", "updated_at"
			) VALUES
				(
					'audit-direct-pending', 301, 101, 'GAME', 'DIRECT_MULTIPART',
					'pending.zip', 5242880, 5242880, 1,
					'SHA256_BLOCK_MANIFEST_V1', repeat('e', 64), 1048576,
					decode(repeat('ee', 160), 'hex'), 'PENDING', NULL,
					'audit-pending-upload', 'direct/audit-pending.zip',
					clock_timestamp() + interval '1 day', clock_timestamp()
				),
				(
					'audit-direct-verifying', 302, 101, 'WEBGL', 'DIRECT_MULTIPART',
					'webgl.zip', 5242880, 5242880, 1,
					'SHA256_BLOCK_MANIFEST_V1', repeat('f', 64), 1048576,
					decode(repeat('ff', 160), 'hex'), 'VERIFYING', '${webglSource}',
					NULL, '${webglSource}',
					clock_timestamp() + interval '1 day', clock_timestamp()
				)
		`);

		await withSchemaClient(schema, async (client) => {
			const audit = await auditGameUploadCutover(client, {
				publicBucket: 'custom-public',
				protectedBucket: 'custom-protected',
			});
			expect(audit.schemaState).toBe('LEGACY_PRESENT');
			expect(audit.legacySessions.total).toBe(0);
			expect(audit.preFenceDirectSessions).toEqual({
				total: 2,
				byStatus: { pending: 1, completing: 0, verifying: 1 },
				malformedLocators: 0,
			});
			expect(audit.residue).toMatchObject({
				protectedExactTargets: 2,
				publicGenerationPrefixTargets: 1,
			});
			expect(audit.safeToMigrate).toBe(false);
			expect(audit.blockers).toEqual(expect.arrayContaining([
				{ category: 'PROTECTED_BUCKET_NAMESPACE_MISMATCH', count: 1 },
				{ category: 'PUBLIC_BUCKET_NAMESPACE_MISMATCH', count: 1 },
			]));
		});
	}, 120_000);

	it('audits 130000-applied/150000-pending direct residue and skips it only after the fence migration', async () => {
		const schema = await createPreTargetFenceSchema();
		await seedPreTargetFenceFixture(schema);
		await withSchemaClient(schema, async (client) => {
			const [schemaState] = await client.$queryRawUnsafe<Array<{
				schema: string; hasExpectedTargetFence: boolean;
			}>>(`
				SELECT current_schema() AS "schema", EXISTS (
					SELECT 1 FROM information_schema.columns
					WHERE table_schema = current_schema()
						AND table_name = 'game_upload_sessions'
						AND column_name = 'expected_target_asset_id'
				) AS "hasExpectedTargetFence"
			`);
			expect(schemaState).toEqual({ schema, hasExpectedTargetFence: false });
			const custom = await auditGameUploadCutover(client, {
				publicBucket: 'custom-public',
				protectedBucket: 'custom-protected',
			});
			expect(custom.schemaState).toBe('DIRECT_PRE_FENCE');
			expect(custom.preFenceDirectSessions).toEqual({
				total: 3,
				byStatus: { pending: 1, completing: 1, verifying: 1 },
				malformedLocators: 0,
			});
			expect(custom.residue).toMatchObject({
				protectedExactTargets: 3,
				publicGenerationPrefixTargets: 1,
			});
			expect(custom.safeToMigrate).toBe(false);
			expect(custom.blockers).toEqual(expect.arrayContaining([
				{ category: 'PROTECTED_BUCKET_NAMESPACE_MISMATCH', count: 1 },
				{ category: 'PUBLIC_BUCKET_NAMESPACE_MISMATCH', count: 1 },
			]));

			const canonical = await auditGameUploadCutover(client, {
				publicBucket: 'pcu-public',
				protectedBucket: 'pcu-protected',
			});
			expect(canonical.safeToMigrate).toBe(true);
			expect(canonical.blockers).toEqual([]);
		});

		await executeMigration(schema, targetFenceMigration);
		await withSchemaClient(schema, async (client) => {
			const applied = await auditGameUploadCutover(client, {
				publicBucket: 'custom-public',
				protectedBucket: 'custom-protected',
			});
			expect(applied.schemaState).toBe('DIRECT_ONLY');
			expect(applied.preFenceDirectSessions.total).toBe(0);
			expect(applied.safeToMigrate).toBe(true);
		});
	}, 120_000);

	it('rolls back outbox, terminal state, and destructive DDL when the final DDL fails', async () => {
		const schema = await createHistoricalSchema();
		await seedPreservedFixture(schema);
		const failingMigration = cutoverMigration.replace(
			/COMMIT;\s*$/,
			'ALTER TABLE "intentional_cutover_failure" DROP COLUMN "missing";\nCOMMIT;\n',
		);
		await expect(executeMigration(schema, failingMigration)).rejects.toThrow();

		const q = quotedIdentifier(schema);
		const [pending] = await control.$queryRawUnsafe<Array<{
			status: string;
			s3_key: string | null;
			s3_upload_id: string | null;
		}>>(`
			SELECT "status", "s3_key", "s3_upload_id"
			FROM ${q}."game_upload_sessions" WHERE "id" = 'legacy-pending'
		`);
		expect(pending).toEqual({
			status: 'PENDING', s3_key: 'legacy/pending.zip', s3_upload_id: 'upload-pending',
		});
		const [existingAbort] = await control.$queryRawUnsafe<Array<{ state: string }>>(`
			SELECT "state"::text FROM ${q}."multipart_abort_tasks" WHERE "id" = 'existing-abort'
		`);
		expect(existingAbort).toEqual({ state: 'RESOLVED' });
		expect(await catalog(schema)).toMatchObject({
			tables: ['game_upload_part_claims', 'game_upload_parts'],
			hasTransportType: true,
		});
	}, 120_000);

	it('preserves READY and completed pointers while keeping exact abort and terminalizing the legacy candidate', async () => {
		const schema = await createHistoricalSchema();
		await seedOwners(schema);
		const q = quotedIdentifier(schema);
		await control.$executeRawUnsafe(`
			INSERT INTO ${q}."game_upload_sessions" (
				"id", "project_id", "user_id", "upload_kind", "transport",
				"original_name", "total_bytes", "chunk_size_bytes", "total_chunks",
				"source_identity_algorithm", "source_identity",
				"source_identity_block_size_bytes", "source_identity_block_manifest",
					"status", "s3_key", "s3_upload_id", "expires_at", "updated_at"
				) VALUES (
					'legacy-conflict', 301, 101, 'GAME', 'API_CHUNK_PROXY',
				'conflict.zip', 5242880, 5242880, 1,
				'SHA256_BLOCK_MANIFEST_V1', repeat('d', 64), 1048576,
				decode(repeat('de', 160), 'hex'),
					'PENDING', 'ready/conflict.zip', 'upload-conflict',
					clock_timestamp() + interval '1 day', clock_timestamp()
				), (
					'legacy-completed-owner', 304, 101, 'GAME', 'API_CHUNK_PROXY',
					'owner.zip', 5242880, 5242880, 1,
					NULL, NULL, NULL, NULL,
					'COMPLETED', 'ready/conflict.zip', NULL,
					clock_timestamp() + interval '1 day', clock_timestamp()
				);
			INSERT INTO ${q}."assets" (
				"project_id", "kind", "status", "storage_key", "updated_at"
				) VALUES (301, 'GAME', 'READY', 'ready/conflict.zip', clock_timestamp());
		`);
		const auditProcess = spawnSync(
			process.platform === 'win32' ? 'npm.cmd' : 'npm',
			['exec', '--', 'tsx', 'scripts/audit-game-upload-cutover.ts'],
			{
				cwd: process.cwd(), encoding: 'utf8',
				env: {
					...process.env,
					DATABASE_URL: schemaDatabaseUrl(schema),
					S3_BUCKET_PUBLIC: 'pcu-public',
					S3_BUCKET_PROTECTED: 'pcu-protected',
				},
			},
		);
		expect(auditProcess.status, auditProcess.stderr).toBe(0);
		expect(auditProcess.stdout.startsWith('{')).toBe(true);
		const collisionAudit = JSON.parse(auditProcess.stdout) as {
			safeToMigrate: boolean;
			collisions: Record<string, number>;
			blockers: unknown[];
		};
		expect(collisionAudit).toMatchObject({ safeToMigrate: true, blockers: [] });
		expect(collisionAudit.collisions).toMatchObject({ readyAssets: 1, preservedSessions: 1 });

		await executeMigration(schema, cutoverMigration);
		const [session] = await control.$queryRawUnsafe<Array<{
			status: string; s3_key: string | null;
		}>>(`
			SELECT "status", "s3_key" FROM ${q}."game_upload_sessions"
			WHERE "id" = 'legacy-conflict'
		`);
		expect(session).toEqual({ status: 'FAILED', s3_key: null });
		const [completed] = await control.$queryRawUnsafe<Array<{
			status: string; storage_key: string;
		}>>(`
			SELECT "status", "storage_key" FROM ${q}."game_upload_sessions"
			WHERE "id" = 'legacy-completed-owner'
		`);
		expect(completed).toEqual({ status: 'COMPLETED', storage_key: 'ready/conflict.zip' });
		const [outbox] = await control.$queryRawUnsafe<Array<{ count: bigint }>>(`
			SELECT count(*) AS "count" FROM ${q}."orphan_objects"
		`);
		expect(Number(outbox?.count)).toBe(0);
		const [abort] = await control.$queryRawUnsafe<Array<{
			storage_key: string; upload_id: string; state: string;
		}>>(`
			SELECT "storage_key", "upload_id", "state"::text
			FROM ${q}."multipart_abort_tasks"
		`);
		expect(abort).toEqual({
			storage_key: 'ready/conflict.zip', upload_id: 'upload-conflict', state: 'PENDING',
		});
	}, 120_000);

	it('fails closed when a completed legacy session has conflicting locators', async () => {
		const schema = await createHistoricalSchema();
		await seedOwners(schema);
		const q = quotedIdentifier(schema);
		await control.$executeRawUnsafe(`
			INSERT INTO ${q}."game_upload_sessions" (
				"id", "project_id", "user_id", "upload_kind", "transport",
				"original_name", "total_bytes", "chunk_size_bytes", "total_chunks",
				"status", "storage_key", "s3_key", "expires_at", "updated_at"
			) VALUES (
				'legacy-completed-mismatch', 304, 101, 'GAME', 'API_CHUNK_PROXY',
				'mismatch.zip', 5242880, 5242880, 1, 'COMPLETED',
				'completed/a.zip', 'completed/b.zip',
				clock_timestamp() + interval '1 day', clock_timestamp()
			)
		`);
		await expect(executeMigration(schema, cutoverMigration)).rejects.toThrow(
			/conflicting object locators/,
		);
		expect(await catalog(schema)).toMatchObject({ hasTransportType: true });
	}, 120_000);

	it('fails closed when a live deletion claim owns the same key with another target kind', async () => {
		const schema = await createHistoricalSchema();
		await seedOwners(schema);
		const q = quotedIdentifier(schema);
		await control.$executeRawUnsafe(`
			INSERT INTO ${q}."game_upload_sessions" (
				"id", "project_id", "user_id", "upload_kind", "transport",
				"original_name", "total_bytes", "chunk_size_bytes", "total_chunks",
				"source_identity_algorithm", "source_identity",
				"source_identity_block_size_bytes", "source_identity_block_manifest",
				"status", "s3_key", "expires_at", "updated_at"
			) VALUES (
				'legacy-target-kind-conflict', 301, 101, 'GAME', 'API_CHUNK_PROXY',
				'conflict.zip', 5242880, 5242880, 1,
				'SHA256_BLOCK_MANIFEST_V1', repeat('e', 64), 1048576,
				decode(repeat('ef', 160), 'hex'), 'PENDING', 'legacy/target-kind.zip',
				clock_timestamp() + interval '1 day', clock_timestamp()
			);
			INSERT INTO ${q}."orphan_objects" (
				"bucket", "storage_key", "reason", "target_kind", "state",
				"claim_token", "claim_until"
			) VALUES (
				'pcu-protected', 'legacy/target-kind.zip', 'existing', 'PREFIX',
				'DELETE_CLAIMED', 'live-claim', clock_timestamp() + interval '5 minutes'
			)
		`);
		await expect(executeMigration(schema, cutoverMigration)).rejects.toThrow(
			/active deletion claims have conflicting target kinds/,
		);
	}, 120_000);

	it('applies 130000 then 140000 then 150000 and terminalizes every pre-fence direct row with exact durable cleanup', async () => {
		const schema = await createPreTargetFenceSchema();
		await seedPreTargetFenceFixture(schema);
		await executeMigration(schema, targetFenceMigration);
		const q = quotedIdentifier(schema);

		const sessions = await control.$queryRawUnsafe<Array<{
			id: string; status: string; storageKey: string | null;
			s3Key: string | null; s3UploadId: string | null;
		}>>(`
			SELECT "id", "status"::text, "storage_key" AS "storageKey",
				"s3_key" AS "s3Key", "s3_upload_id" AS "s3UploadId"
			FROM ${q}."game_upload_sessions" ORDER BY "id"
		`);
		expect(sessions).toEqual([
			{
				id: 'pre-fence-completing', status: 'REJECTED',
				storageKey: 'direct/completing.zip', s3Key: null, s3UploadId: null,
			},
			{
				id: 'pre-fence-pending', status: 'REJECTED',
				storageKey: 'direct/pending.zip', s3Key: null, s3UploadId: null,
			},
			{
				id: 'pre-fence-verifying', status: 'REJECTED',
				storageKey: 'webgl/303/22222222-2222-4222-8222-222222222222/source.zip',
				s3Key: null, s3UploadId: null,
			},
		]);
		const [active] = await control.$queryRawUnsafe<Array<{ count: bigint }>>(`
			SELECT count(*) AS "count" FROM ${q}."game_upload_active_sessions"
		`);
		expect(Number(active?.count)).toBe(0);

		const aborts = await control.$queryRawUnsafe<Array<{
			storageKey: string; uploadId: string; state: string;
		}>>(`
			SELECT "storage_key" AS "storageKey", "upload_id" AS "uploadId", "state"::text
			FROM ${q}."multipart_abort_tasks" ORDER BY "storage_key"
		`);
		expect(aborts).toEqual([
			{ storageKey: 'direct/completing.zip', uploadId: 'completing-upload-id', state: 'PENDING' },
			{ storageKey: 'direct/pending.zip', uploadId: 'pending-upload-id', state: 'PENDING' },
		]);
		const orphans = await control.$queryRawUnsafe<Array<{
			bucket: string; storageKey: string; targetKind: string; state: string;
		}>>(`
			SELECT "bucket", "storage_key" AS "storageKey",
				"target_kind"::text AS "targetKind", "state"::text
			FROM ${q}."orphan_objects" ORDER BY "bucket", "storage_key"
		`);
		expect(orphans).toEqual([
			{ bucket: 'pcu-protected', storageKey: 'direct/completing.zip', targetKind: 'EXACT', state: 'PENDING' },
			{ bucket: 'pcu-protected', storageKey: 'direct/pending.zip', targetKind: 'EXACT', state: 'PENDING' },
			{
				bucket: 'pcu-protected',
				storageKey: 'webgl/303/22222222-2222-4222-8222-222222222222/source.zip',
				targetKind: 'EXACT', state: 'PENDING',
			},
			{
				bucket: 'pcu-public',
				storageKey: 'webgl/303/22222222-2222-4222-8222-222222222222/site/',
				targetKind: 'PREFIX', state: 'PENDING',
			},
		]);

		await withSchemaClient(schema, async (client) => {
			const abortMultipart = vi.fn(async () => undefined);
			const abortWorker = createMultipartAbortService({
				repository: createMultipartAbortRepository(client),
				storage: { abortMultipart },
				clock: { now: () => new Date() },
				ids: { next: () => randomUUID() },
				logger: { error: vi.fn() },
			});
			expect(await abortWorker.run()).toEqual({ tried: 2, resolved: 2, failed: 0 });
			expect(await abortWorker.run()).toEqual({ tried: 0, resolved: 0, failed: 0 });
			expect(abortMultipart.mock.calls).toEqual(expect.arrayContaining([
				['pcu-protected', 'direct/pending.zip', 'pending-upload-id', expect.objectContaining({ signal: expect.any(AbortSignal) })],
				['pcu-protected', 'direct/completing.zip', 'completing-upload-id', expect.objectContaining({ signal: expect.any(AbortSignal) })],
			]));

			const deleteObject = vi.fn(async () => undefined);
			const listKeyPage = vi.fn(async () => ({ keys: [], isTruncated: false }));
			const deletionWorker = {
				clock: { now: () => new Date() },
				storage: {
					delete: deleteObject,
					listKeyPage,
					deleteKeys: vi.fn(async () => ({ deleted: [], failures: [] })),
				},
				repository: createOrphanRepository(client),
				references: { collect: async () => ({ references: [], unsafeBuckets: new Set<string>() }) },
				ids: { next: () => randomUUID() },
				logger: { info: vi.fn(), error: vi.fn() },
			};
			expect(await runOrphanReaper(deletionWorker)).toEqual({ tried: 4, resolved: 4, failed: 0 });
			expect(await runOrphanReaper(deletionWorker)).toEqual({ tried: 0, resolved: 0, failed: 0 });
			expect(deleteObject).toHaveBeenCalledTimes(3);
			expect(listKeyPage).toHaveBeenCalledWith(
				'pcu-public',
				'webgl/303/22222222-2222-4222-8222-222222222222/site/',
				{ maxKeys: 1000 },
				expect.objectContaining({
					requestTimeoutMs: 60_000,
					signal: expect.any(AbortSignal),
				}),
			);
		});
	}, 120_000);

	it.each([
		{
			name: 'upload id without its exact key',
			status: 'PENDING', storageKey: null, s3Key: null, uploadId: 'lost-key-upload',
			error: /multipart upload ids have no exact key/,
		},
		{
			name: 'active key without its multipart upload id',
			status: 'COMPLETING', storageKey: null, s3Key: 'direct/inverse.zip', uploadId: null,
			error: /active multipart rows have incomplete exact locators/,
		},
		{
			name: 'VERIFYING aliases that disagree',
			status: 'VERIFYING', storageKey: 'direct/b.zip', s3Key: 'direct/a.zip', uploadId: null,
			error: /VERIFYING rows have conflicting exact locators/,
		},
	])('blocks $name before any locator or schema mutation', async (fixture) => {
		const schema = await createPreTargetFenceSchema();
		await seedOwners(schema);
		const q = quotedIdentifier(schema);
		await control.$executeRawUnsafe(`
			INSERT INTO ${q}."game_upload_sessions" (
				"id", "project_id", "user_id", "upload_kind", "original_name",
				"total_bytes", "chunk_size_bytes", "total_chunks",
				"source_identity_algorithm", "source_identity",
				"source_identity_block_size_bytes", "source_identity_block_manifest", "status",
				"storage_key", "s3_key", "s3_upload_id", "expires_at", "updated_at"
			) VALUES (
				'malformed-pre-fence', 301, 101, 'GAME', 'malformed.zip',
				5242880, 5242880, 1, 'SHA256_BLOCK_MANIFEST_V1', repeat('d', 64),
				1048576, decode(repeat('dd', 160), 'hex'), '${fixture.status}',
				${fixture.storageKey === null ? 'NULL' : `'${fixture.storageKey}'`},
				${fixture.s3Key === null ? 'NULL' : `'${fixture.s3Key}'`},
				${fixture.uploadId === null ? 'NULL' : `'${fixture.uploadId}'`},
				clock_timestamp() + interval '1 day', clock_timestamp()
			)
		`);
		await expect(executeMigration(schema, targetFenceMigration)).rejects.toThrow(fixture.error);
		const [preserved] = await control.$queryRawUnsafe<Array<{
			status: string; storageKey: string | null; s3Key: string | null; uploadId: string | null;
		}>>(`
			SELECT "status"::text, "storage_key" AS "storageKey", "s3_key" AS "s3Key",
				" s3_upload_id" AS "uploadId"
			FROM ${q}."game_upload_sessions" WHERE "id" = 'malformed-pre-fence'
		`.replace('" s3_upload_id"', '"s3_upload_id"'));
		expect(preserved).toMatchObject({
			status: fixture.status,
			storageKey: fixture.storageKey,
			s3Key: fixture.s3Key,
			uploadId: fixture.uploadId,
		});
		const [columns] = await control.$queryRawUnsafe<Array<{ count: bigint }>>(`
			SELECT count(*) AS "count" FROM information_schema.columns
			WHERE "table_schema" = '${schema}' AND "table_name" = 'game_upload_sessions'
				AND "column_name" = 'expected_target_asset_id'
		`);
		expect(Number(columns?.count)).toBe(0);
	}, 120_000);

	it('rolls back pre-fence terminalization and exact outboxes when the final 150000 DDL fails', async () => {
		const schema = await createPreTargetFenceSchema();
		await seedPreTargetFenceFixture(schema);
		const failingMigration = targetFenceMigration.replace(
			/COMMIT;\s*$/,
			'ALTER TABLE "intentional_target_fence_failure" DROP COLUMN "missing";\nCOMMIT;\n',
		);
		await expect(executeMigration(schema, failingMigration)).rejects.toThrow();
		const q = quotedIdentifier(schema);
		const [pending] = await control.$queryRawUnsafe<Array<{
			status: string; s3Key: string; uploadId: string;
		}>>(`
			SELECT "status"::text, "s3_key" AS "s3Key", "s3_upload_id" AS "uploadId"
			FROM ${q}."game_upload_sessions" WHERE "id" = 'pre-fence-pending'
		`);
		expect(pending).toEqual({
			status: 'PENDING', s3Key: 'direct/pending.zip', uploadId: 'pending-upload-id',
		});
		const [abort] = await control.$queryRawUnsafe<Array<{ state: string; reason: string }>>(`
			SELECT "state"::text, "reason" FROM ${q}."multipart_abort_tasks"
			WHERE "id" = 'pre-fence-existing-abort'
		`);
		expect(abort).toEqual({ state: 'RESOLVED', reason: 'old-reason' });
		const [columns] = await control.$queryRawUnsafe<Array<{ count: bigint }>>(`
			SELECT count(*) AS "count" FROM information_schema.columns
			WHERE "table_schema" = '${schema}' AND "table_name" = 'game_upload_sessions'
				AND "column_name" = 'expected_target_asset_id'
		`);
		expect(Number(columns?.count)).toBe(0);
	}, 120_000);
});
