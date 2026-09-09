import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';

const runPostgresIntegration = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';
const migrationRootUrl = new URL('../../prisma/migrations/', import.meta.url);
const phaseOneMigration = '20260821800000_project_video_order_expand';
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

describe.runIf(runPostgresIntegration)('canonical asset contract PostgreSQL path', () => {
	let databaseUrl = '';
	let control: PrismaClient;
	const schemas: string[] = [];

	async function freshSchema(label: string): Promise<string> {
		const schema = `canonical_contract_${label}_${randomUUID().replaceAll('-', '')}`;
		await control.$executeRawUnsafe(`CREATE SCHEMA ${quoted(schema)}`);
		schemas.push(schema);
		return schema;
	}

	async function applyMigrations(schema: string, through?: string): Promise<void> {
		const directories = (await readdir(migrationRootUrl, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory() && (!through || entry.name <= through))
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
	}

	async function applyContract(schema: string, setup = ''): Promise<void> {
		const sql = await readFile(
			new URL('20260822000000_canonical_asset_contract/migration.sql', migrationRootUrl),
			'utf8',
		);
		const connection = createPrismaClientForDatabase(databaseUrl);
		try {
			await connection.$connect();
			await connection.$executeRawUnsafe(`SET search_path TO ${quoted(schema)};\n${setup}\n${sql}`);
		} finally {
			await connection.$disconnect();
		}
	}

	async function seedObservedMetrics(schema: string, observationSql: string, value = 0): Promise<void> {
		const values = legacyMetricNames.map((name) => `('${name}')`).join(',');
		await control.$executeRawUnsafe(`
			INSERT INTO ${quoted(schema)}."migration_metrics"
				("name", "scope", "value", "last_observed_at", "created_at", "updated_at")
			SELECT metric.name, '', ${value}, ${observationSql}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
			FROM (VALUES ${values}) metric(name)
		`);
	}

	async function seedStorageBuckets(schema: string): Promise<void> {
		await control.$executeRawUnsafe(`
			INSERT INTO ${quoted(schema)}."storage_buckets" ("bucket", "visibility", "created_at", "updated_at") VALUES
				('protected', 'PROTECTED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
				('public', 'PUBLIC', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
			ON CONFLICT ("bucket") DO NOTHING
		`);
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

	it('applies the full fresh path and installs final ownership guards', async () => {
		const schema = await freshSchema('fresh');
		await applyMigrations(schema);
		await seedStorageBuckets(schema);

		const [catalog] = await control.$queryRawUnsafe<Array<{
			legacyAssetColumns: bigint;
			legacyTables: bigint;
			ownerCheck: boolean;
			objectOwnerTrigger: boolean;
			webglGuard: boolean;
			publicNamespaceIndex: string | null;
			abortLocator: boolean;
			canonicalCapabilityColumns: bigint;
			legacyCapabilityColumns: bigint;
			legacyCapabilityIndex: boolean;
			canonicalCapabilityCheck: boolean;
		}>>(`
			SELECT
				(SELECT count(*) FROM information_schema.columns
				 WHERE table_schema = '${schema}' AND table_name = 'assets'
				   AND column_name IN ('storage_key', 'playback_storage_key', 'mime_type', 'size_bytes', 'playback_status')) AS "legacyAssetColumns",
				(SELECT count(*) FROM information_schema.tables
				 WHERE table_schema = '${schema}'
				   AND table_name IN ('migration_metrics', 'game_upload_sessions', 'game_upload_parts', 'game_upload_part_claims', 'game_upload_active_sessions')) AS "legacyTables",
				EXISTS (SELECT 1 FROM information_schema.table_constraints
				 WHERE constraint_schema = '${schema}' AND table_name = 'assets' AND constraint_name = 'assets_owner_xor_check') AS "ownerCheck",
				EXISTS (SELECT 1 FROM information_schema.triggers
				 WHERE trigger_schema = '${schema}' AND event_object_table = 'asset_representations'
				   AND trigger_name = 'asset_representations_distinct_owner_guard') AS "objectOwnerTrigger",
				EXISTS (SELECT 1 FROM information_schema.triggers
				 WHERE trigger_schema = '${schema}' AND event_object_table = 'webgl_deployments'
				   AND trigger_name = 'webgl_deployments_canonical_guard') AS "webglGuard",
				pg_get_indexdef(to_regclass('${schema}.webgl_deployments_public_bucket_prefix_key')) AS "publicNamespaceIndex",
				EXISTS (SELECT 1 FROM information_schema.columns
				 WHERE table_schema = '${schema}' AND table_name = 'multipart_abort_tasks' AND column_name = 'upload_session_id') AS "abortLocator",
				(SELECT count(*) FROM information_schema.columns
				 WHERE table_schema = '${schema}' AND table_name = 'asset_upload_sessions'
				   AND column_name IN ('part_capability_issued_count', 'part_capability_first_issued_at', 'part_capability_last_issued_at')) AS "canonicalCapabilityColumns",
				(SELECT count(*) FROM information_schema.columns
				 WHERE table_schema = '${schema}' AND table_name = 'asset_upload_sessions'
				   AND column_name IN ('part_url_issue_window_count', 'part_url_issue_window_started_at', 'part_url_last_issued_at')) AS "legacyCapabilityColumns",
				to_regclass('${schema}.asset_upload_sessions_part_url_issue_window_idx') IS NOT NULL AS "legacyCapabilityIndex",
				EXISTS (SELECT 1 FROM information_schema.table_constraints
				 WHERE constraint_schema = '${schema}' AND table_name = 'asset_upload_sessions'
				   AND constraint_name = 'asset_upload_sessions_part_capability_issued_count_check') AS "canonicalCapabilityCheck"
		`);

		expect(catalog).toEqual({
			legacyAssetColumns: 0n,
			legacyTables: 0n,
			ownerCheck: true,
			objectOwnerTrigger: true,
			webglGuard: true,
			publicNamespaceIndex: expect.stringMatching(/^CREATE UNIQUE INDEX .*\(public_bucket, public_prefix\)$/),
			abortLocator: true,
			canonicalCapabilityColumns: 3n,
			legacyCapabilityColumns: 0n,
			legacyCapabilityIndex: false,
			canonicalCapabilityCheck: true,
		});

		await expect(control.$executeRawUnsafe(`
			SET search_path TO ${quoted(schema)};
			INSERT INTO "assets" ("kind", "status", "original_name", "created_at", "updated_at")
			VALUES ('GAME', 'FAILED', 'ownerless.zip', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		`)).rejects.toThrow();

		await control.$executeRawUnsafe(`
			SET search_path TO ${quoted(schema)};
			INSERT INTO "exhibitions" ("id", "year", "title", "created_at", "updated_at")
			VALUES (82001, 2027, 'Object owner guard', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
			INSERT INTO "assets" ("id", "exhibition_id", "kind", "status", "original_name", "created_at", "updated_at") VALUES
				(82101, 82001, 'POSTER', 'FAILED', 'one.jpg', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
				(82102, 82001, 'POSTER', 'FAILED', 'two.jpg', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
			INSERT INTO "asset_representations" ("id", "asset_id", "role", "bucket", "object_key", "mime_type", "size_bytes", "state", "created_at", "updated_at") VALUES
				('same-owner-original', 82101, 'ORIGINAL', 'public', 'shared-object.jpg', 'image/jpeg', 10, 'READY', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
				('same-owner-card', 82101, 'CARD_480', 'public', 'shared-object.jpg', 'image/jpeg', 10, 'READY', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		`);
		await expect(control.$executeRawUnsafe(`
			SET search_path TO ${quoted(schema)};
			INSERT INTO "asset_representations" ("id", "asset_id", "role", "bucket", "object_key", "mime_type", "size_bytes", "state", "created_at", "updated_at")
			VALUES ('different-owner', 82102, 'ORIGINAL', 'public', 'shared-object.jpg', 'image/jpeg', 10, 'READY', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		`)).rejects.toThrow(/physical object cannot be owned by more than one asset/);

		const checksum = 'a'.repeat(64);
		await control.$executeRawUnsafe(`
			SET search_path TO ${quoted(schema)};
			BEGIN;
			INSERT INTO "users" ("id", "google_sub", "email", "name", "picture", "role", "created_at", "updated_at")
			VALUES (82201, 'staged-webgl-owner', 'staged-webgl@example.test', 'Staged WebGL', '', 'ADMIN', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
			INSERT INTO "exhibitions" ("id", "year", "title", "created_at", "updated_at")
			VALUES (82201, 2028, 'Staged WebGL', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
			INSERT INTO "projects" ("id", "exhibition_id", "slug", "title", "status", "creator_id", "created_at", "updated_at")
			VALUES (82201, 82201, 'staged-webgl', 'Staged WebGL', 'DRAFT', 82201, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
			INSERT INTO "project_submissions" ("id", "project_id", "actor_id", "state", "created_at", "updated_at")
			VALUES ('staged-webgl-submission', 82201, 82201, 'PENDING', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
			INSERT INTO "assets" ("id", "project_id", "kind", "status", "original_name", "created_at", "updated_at")
			VALUES (82201, 82201, 'WEBGL', 'READY', 'source.zip', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
			INSERT INTO "asset_representations" ("id", "asset_id", "role", "bucket", "object_key", "mime_type", "size_bytes", "etag", "state", "created_at", "updated_at")
			VALUES ('staged-webgl-source', 82201, 'WEBGL_SOURCE', 'protected', 'protected/uploads/staged/source.zip', 'application/zip', 100, '"garage-etag"', 'READY', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
			INSERT INTO "webgl_deployments" (
				"id", "project_id", "source_representation_id", "public_bucket", "public_prefix", "entry_object_key",
				"object_manifest", "staging_bucket", "staging_prefix", "staging_entry_object_key", "staging_object_manifest",
				"state", "created_at", "updated_at"
			) VALUES (
				'staged-webgl-deployment', 82201, 'staged-webgl-source', 'public',
				'public/webgl/82201/staged-webgl-deployment/', 'public/webgl/82201/staged-webgl-deployment/index.html',
				NULL, 'protected', 'protected/publication-staging/staged-webgl-submission/staged-webgl-deployment/',
				'protected/publication-staging/staged-webgl-submission/staged-webgl-deployment/index.html',
				jsonb_build_object('version', 1, 'objects', jsonb_build_array(jsonb_build_object(
					'objectKey', 'protected/publication-staging/staged-webgl-submission/staged-webgl-deployment/index.html',
					'sizeBytes', '42', 'mimeType', 'text/html', 'checksumSha256', '${checksum}'
				))),
				'READY', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
			);
			COMMIT
		`);

		await expect(control.$executeRawUnsafe(`
			SET search_path TO ${quoted(schema)};
			UPDATE "webgl_deployments"
			SET "object_manifest" = jsonb_build_object('version', 1, 'objects', '[]'::jsonb)
			WHERE "id" = 'staged-webgl-deployment'
		`)).rejects.toThrow(/webgl_deployments_ready_manifest_check|READY staged WebGL/);

		await expect(control.$executeRawUnsafe(`
			SET search_path TO ${quoted(schema)};
			UPDATE "webgl_deployments"
			SET "staging_object_manifest" = jsonb_build_object('version', 1, 'objects', jsonb_build_array(jsonb_build_object(
				'objectKey', 'protected/not-the-reserved-prefix/index.html',
				'sizeBytes', '42', 'mimeType', 'text/html', 'checksumSha256', '${checksum}'
			)))
			WHERE "id" = 'staged-webgl-deployment'
		`)).rejects.toThrow(/READY staged WebGL deployment requires a complete checksummed staging manifest/);

		await expect(control.$executeRawUnsafe(`
			SET search_path TO ${quoted(schema)};
			UPDATE "projects" SET "current_webgl_deployment_id" = 'staged-webgl-deployment' WHERE "id" = 82201
		`)).rejects.toThrow(/project current WebGL pointer (?:must reference its own READY deployment|requires a PUBLISHED project)/);

		await expect(control.$executeRawUnsafe(`
			SET search_path TO ${quoted(schema)};
			UPDATE "webgl_deployments" SET
				"object_manifest" = jsonb_build_object('version', 1, 'objects', jsonb_build_array(jsonb_build_object(
					'objectKey', 'public/webgl/82201/staged-webgl-deployment/index.html',
					'sizeBytes', '42', 'mimeType', 'text/html', 'checksumSha256', '${checksum}'
				))),
				"staging_bucket" = NULL, "staging_prefix" = NULL,
				"staging_entry_object_key" = NULL, "staging_object_manifest" = NULL
			WHERE "id" = 'staged-webgl-deployment'
		`)).rejects.toThrow(/DRAFT project WebGL deployments must remain protected and unpublished/);

		const stagingId = '11111111-1111-4111-8111-111111111111';
		await control.$executeRawUnsafe(`
			SET search_path TO ${quoted(schema)};
			BEGIN;
			INSERT INTO "assets" ("id", "project_id", "kind", "status", "original_name", "created_at", "updated_at")
			VALUES (82202, 82201, 'IMAGE', 'READY', 'draft.webp', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
			INSERT INTO "asset_representations" (
				"id", "asset_id", "role", "bucket", "object_key", "publication_bucket", "publication_object_key",
				"mime_type", "size_bytes", "checksum_algorithm", "checksum", "source_identity_algorithm", "source_identity",
				"state", "created_at", "updated_at"
			) VALUES
				('draft-image-original', 82202, 'ORIGINAL', 'protected', 'protected/publication-staging/projects/82201/images/${stagingId}/original/1.webp', 'public', 'public/images/82202/original/1.webp', 'image/webp', 42, 'SHA256', '${checksum}', 'SHA256_BLOCK_MANIFEST_V1', '${checksum}', 'READY', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
				('draft-image-card', 82202, 'CARD_480', 'protected', 'protected/publication-staging/projects/82201/images/${stagingId}/card_480/1.webp', 'public', 'public/images/82202/card_480/1.webp', 'image/webp', 42, 'SHA256', '${checksum}', 'SHA256_BLOCK_MANIFEST_V1', '${checksum}', 'READY', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
				('draft-image-display', 82202, 'DISPLAY_960', 'protected', 'protected/publication-staging/projects/82201/images/${stagingId}/display_960/1.webp', 'public', 'public/images/82202/display_960/1.webp', 'image/webp', 42, 'SHA256', '${checksum}', 'SHA256_BLOCK_MANIFEST_V1', '${checksum}', 'READY', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
			COMMIT
		`);
		await expect(control.$executeRawUnsafe(`
			SET search_path TO ${quoted(schema)};
			UPDATE "asset_representations" SET "bucket" = 'public', "object_key" = 'public/images/82202/original/1.webp',
				"publication_bucket" = NULL, "publication_object_key" = NULL
			WHERE "id" = 'draft-image-original'
		`)).rejects.toThrow(/DRAFT project image representations must remain in UUID-scoped protected publication staging/);

		await expect(control.$executeRawUnsafe(`
			SET search_path TO ${quoted(schema)};
			UPDATE "asset_representations" SET "bucket" = 'public' WHERE "id" = 'draft-image-original'
		`)).rejects.toThrow(/DRAFT project image representations must remain in UUID-scoped protected publication staging/);
		await expect(control.$executeRawUnsafe(`
			SET search_path TO ${quoted(schema)};
			UPDATE "asset_representations" SET "publication_bucket" = 'protected' WHERE "id" = 'draft-image-card'
		`)).rejects.toThrow(/DRAFT project image representations must remain in UUID-scoped protected publication staging/);
		await expect(control.$executeRawUnsafe(`
			SET search_path TO ${quoted(schema)};
			UPDATE "webgl_deployments" SET "staging_bucket" = 'public' WHERE "id" = 'staged-webgl-deployment'
		`)).rejects.toThrow(/WebGL staging bucket must be registered PROTECTED|DRAFT project WebGL deployments must remain protected and unpublished/);

		await control.$executeRawUnsafe(`
			SET search_path TO ${quoted(schema)};
			INSERT INTO "projects" ("id", "exhibition_id", "slug", "title", "status", "creator_id", "created_at", "updated_at")
			VALUES (82203, 82201, 'wrong-job-project', 'Wrong job project', 'DRAFT', 82201, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		`);
		await expect(control.$executeRawUnsafe(`
			SET search_path TO ${quoted(schema)};
			INSERT INTO "project_publication_jobs" ("id", "project_id", "submission_id", "state", "plan", "created_at", "updated_at")
			VALUES ('cross-project-job', 82203, 'staged-webgl-submission', 'PENDING',
				'{"version":1,"projectId":82203,"submissionId":"staged-webgl-submission","objects":[],"representations":[],"webglDeployments":[]}'::jsonb,
				CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		`)).rejects.toThrow(/project_publication_jobs_submission_project_fkey/);
	});

	it('contracts a representative backfilled fixture and preserves canonical rows', async () => {
		const schema = await freshSchema('clean');
		await applyMigrations(schema, phaseOneMigration);
		await seedStorageBuckets(schema);

		await control.$executeRawUnsafe(`
			SET search_path TO ${quoted(schema)};
			INSERT INTO "users" ("id", "google_sub", "email", "name", "picture", "role", "created_at", "updated_at")
			VALUES (81001, 'contract-user', 'contract@example.test', 'Contract', '', 'ADMIN', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
			INSERT INTO "exhibitions" ("id", "year", "title", "poster_storage_key", "poster_original_name", "poster_mime_type", "poster_size_bytes", "poster_card_480_height", "poster_display_960_height", "created_at", "updated_at")
			VALUES (81001, 2026, 'Contract', 'legacy/exhibition-poster.jpg', 'exhibition.jpg', 'image/jpeg', 400, 320, 640, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
			INSERT INTO "projects" ("id", "exhibition_id", "slug", "title", "status", "webgl_entry_key", "creator_id", "created_at", "updated_at")
			VALUES (81001, 81001, 'contract-project', 'Contract Project', 'PUBLISHED', 'public/webgl/81001/deploy-1/index.html', 81001, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
			INSERT INTO "project_submissions" ("id", "project_id", "actor_id", "state", "published_at", "created_at", "updated_at")
			VALUES ('contract-submission', 81001, 81001, 'PUBLISHED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

			INSERT INTO "assets" ("id", "project_id", "kind", "status", "storage_key", "playback_storage_key", "original_name", "mime_type", "playback_mime_type", "size_bytes", "playback_size_bytes", "playback_status", "is_public", "created_at", "updated_at") VALUES
				(81101, 81001, 'GAME', 'READY', 'protected/game.zip', NULL, 'game.zip', 'application/zip', '', 100, 0, 'PENDING', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
				(81102, 81001, 'VIDEO', 'READY', 'protected/video-original.mp4', 'public/video-playback.mp4', 'video.mp4', 'video/mp4', 'video/mp4', 200, 180, 'READY', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
				(81103, 81001, 'IMAGE', 'READY', 'public/images/81103/original/1.jpg', NULL, 'image.jpg', 'image/jpeg', '', 300, 0, 'PENDING', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
				(81105, 81001, 'WEBGL', 'READY', 'protected/webgl-source.zip', NULL, 'webgl.zip', 'application/zip', '', 120, 0, 'PENDING', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
			UPDATE "assets" SET "card_480_height" = 320, "display_960_height" = 640 WHERE "id" = 81103;
			INSERT INTO "assets" ("id", "exhibition_id", "kind", "status", "storage_key", "original_name", "mime_type", "size_bytes", "card_480_height", "display_960_height", "is_public", "created_at", "updated_at")
			VALUES (81104, 81001, 'POSTER', 'READY', 'legacy/exhibition-poster.jpg', 'exhibition.jpg', 'image/jpeg', 400, 320, 640, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

			INSERT INTO "asset_representations" ("id", "asset_id", "role", "bucket", "object_key", "mime_type", "size_bytes", "state", "created_at", "updated_at") VALUES
				('rep-game-original', 81101, 'ORIGINAL', 'protected', 'protected/game.zip', 'application/zip', 100, 'READY', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
				('rep-webgl-source', 81105, 'WEBGL_SOURCE', 'protected', 'protected/webgl-source.zip', 'application/zip', 120, 'READY', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
				('rep-video-original', 81102, 'ORIGINAL', 'protected', 'protected/video-original.mp4', 'video/mp4', 200, 'READY', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
				('rep-video-playback', 81102, 'PLAYBACK', 'public', 'public/video-playback.mp4', 'video/mp4', 180, 'READY', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
				('rep-image-original', 81103, 'ORIGINAL', 'public', 'public/images/81103/original/1.jpg', 'image/jpeg', 300, 'READY', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
				('rep-image-card', 81103, 'CARD_480', 'public', 'public/images/81103/card_480/1.jpg', 'image/jpeg', 100, 'READY', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
				('rep-image-display', 81103, 'DISPLAY_960', 'public', 'public/images/81103/display_960/1.jpg', 'image/jpeg', 200, 'READY', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
				('rep-exhibition-original', 81104, 'ORIGINAL', 'public', 'public/images/exhibitions/81001/original/1.jpg', 'image/jpeg', 400, 'READY', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
				('rep-exhibition-card', 81104, 'CARD_480', 'public', 'public/images/exhibitions/81001/card_480/1.jpg', 'image/jpeg', 120, 'READY', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
				('rep-exhibition-display', 81104, 'DISPLAY_960', 'public', 'public/images/exhibitions/81001/display_960/1.jpg', 'image/jpeg', 220, 'READY', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

			UPDATE "projects" SET "poster_asset_id" = 81103 WHERE "id" = 81001;
			UPDATE "exhibitions" SET "poster_asset_id" = 81104 WHERE "id" = 81001;
			INSERT INTO "webgl_deployments" ("id", "project_id", "source_representation_id", "public_bucket", "public_prefix", "entry_object_key", "object_manifest", "state", "created_at", "updated_at")
			VALUES (
				'deploy-1', 81001, 'rep-webgl-source', 'public', 'public/webgl/81001/deploy-1/', 'public/webgl/81001/deploy-1/index.html',
				'{"version":1,"objects":[{"objectKey":"public/webgl/81001/deploy-1/index.html","sizeBytes":"42","mimeType":"text/html","etag":"entry-etag","checksumSha256":null}]}'::jsonb,
				'READY', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
			);
			UPDATE "projects" SET "current_webgl_deployment_id" = 'deploy-1' WHERE "id" = 81001;
			INSERT INTO "game_upload_sessions" ("id", "project_id", "user_id", "upload_kind", "original_name", "total_bytes", "chunk_size_bytes", "total_chunks", "status", "expires_at", "created_at", "updated_at")
			VALUES ('legacy-complete', 81001, 81001, 'GAME', 'game.zip', 100, 10, 10, 'COMPLETED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
		`);
		await seedObservedMetrics(schema, `CURRENT_TIMESTAMP - INTERVAL '25 hours'`);

		await applyContract(schema);

		const [result] = await control.$queryRawUnsafe<Array<{
			assets: bigint;
			representations: bigint;
			deployments: bigint;
			legacyTables: bigint;
		}>>(`
			SELECT
				(SELECT count(*) FROM ${quoted(schema)}."assets") AS "assets",
				(SELECT count(*) FROM ${quoted(schema)}."asset_representations") AS "representations",
				(SELECT count(*) FROM ${quoted(schema)}."webgl_deployments") AS "deployments",
				(SELECT count(*) FROM information_schema.tables WHERE table_schema = '${schema}'
				 AND table_name IN ('migration_metrics', 'game_upload_sessions')) AS "legacyTables"
		`);
		expect(result).toEqual({ assets: 5n, representations: 10n, deployments: 1n, legacyTables: 0n });
		await expect(control.$executeRawUnsafe(`
			SET search_path TO ${quoted(schema)};
			UPDATE "asset_representations" SET "role" = 'PLAYBACK' WHERE "id" = 'rep-webgl-source'
		`)).rejects.toThrow(/READY asset lacks its canonical source representation|WebGL deployment source must be a WEBGL_SOURCE/);
		await expect(control.$executeRawUnsafe(`
			SET search_path TO ${quoted(schema)};
			UPDATE "assets" SET "status" = 'FAILED' WHERE "id" = 81103
		`)).rejects.toThrow(/project poster pointer must reference its own READY image asset/);
		await expect(control.$executeRawUnsafe(`
			SET search_path TO ${quoted(schema)};
			UPDATE "assets" SET "kind" = 'IMAGE' WHERE "id" = 81104
		`)).rejects.toThrow(/exhibition poster pointer must reference its own READY POSTER asset/);
		await expect(control.$executeRawUnsafe(`
			SET search_path TO ${quoted(schema)};
			UPDATE "asset_representations" SET "object_key" = 'legacy/exhibition-poster.jpg'
			WHERE "id" = 'rep-exhibition-original'
		`)).rejects.toThrow(/exhibition poster representations must remain in the public image namespace/);
		await expect(control.$executeRawUnsafe(`
			SET search_path TO ${quoted(schema)};
			UPDATE "projects" SET "poster_asset_id" = 81104 WHERE "id" = 81001
		`)).rejects.toThrow(/project poster pointer must reference its own READY image asset/);
		await expect(control.$executeRawUnsafe(`
			SET search_path TO ${quoted(schema)};
			UPDATE "webgl_deployments" SET "state" = 'FAILED' WHERE "id" = 'deploy-1'
		`)).rejects.toThrow(/current WebGL deployment must belong to that project and remain READY|project current WebGL pointer must reference its own READY deployment/);
		await expect(control.$executeRawUnsafe(`
			SET search_path TO ${quoted(schema)};
			UPDATE "assets" SET "status" = 'FAILED' WHERE "id" = 81105
		`)).rejects.toThrow(/READY WebGL deployment requires a READY WEBGL asset and READY WEBGL_SOURCE/);
		await expect(control.$executeRawUnsafe(`
			SET search_path TO ${quoted(schema)};
			UPDATE "projects" SET "status" = 'DRAFT' WHERE "id" = 81001
		`)).rejects.toThrow(/published project cannot return to DRAFT/);
		await expect(control.$executeRawUnsafe(`
			SET search_path TO ${quoted(schema)};
			UPDATE "project_submissions" SET "state" = 'FINALIZING', "published_at" = NULL WHERE "id" = 'contract-submission'
		`)).rejects.toThrow(/published submission cannot return to a mutable state/);
		await expect(control.$executeRawUnsafe(`
			SET search_path TO ${quoted(schema)};
			UPDATE "asset_representations" SET "bucket" = 'protected',
				"object_key" = 'protected/publication-staging/reversed/original.webp',
				"publication_bucket" = 'public', "publication_object_key" = 'public/images/81103/original/2.webp'
			WHERE "id" = 'rep-image-original'
		`)).rejects.toThrow(/PUBLISHED project image representations cannot return to protected staging/);
		await expect(control.$executeRawUnsafe(`
			SET search_path TO ${quoted(schema)};
			UPDATE "webgl_deployments" SET
				"object_manifest" = NULL,
				"staging_bucket" = 'protected', "staging_prefix" = 'protected/publication-staging/reversed/',
				"staging_entry_object_key" = 'protected/publication-staging/reversed/index.html',
				"staging_object_manifest" = '{"version":1,"objects":[{"objectKey":"protected/publication-staging/reversed/index.html","sizeBytes":"42","mimeType":"text/html","checksumSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}'::jsonb
			WHERE "id" = 'deploy-1'
		`)).rejects.toThrow(/PUBLISHED project WebGL deployments cannot return to protected staging|READY staged WebGL deployment/);
		await control.$executeRawUnsafe(`
			SET search_path TO ${quoted(schema)};
			UPDATE "asset_representations" SET "state" = 'FAILED', "error" = 'transcode failed' WHERE "id" = 'rep-video-playback'
		`);
		const [video] = await control.$queryRawUnsafe<Array<{ assetState: string; playbackState: string }>>(`
			SELECT a."status"::text AS "assetState", r."state"::text AS "playbackState"
			FROM ${quoted(schema)}."assets" a
			JOIN ${quoted(schema)}."asset_representations" r ON r."asset_id" = a."id" AND r."role"::text = 'PLAYBACK'
			WHERE a."id" = 81102
		`);
		expect(video).toEqual({ assetState: 'READY', playbackState: 'FAILED' });

		const targetMutation = createPrismaClientForDatabase(databaseUrl);
		const pointerMutation = createPrismaClientForDatabase(databaseUrl);
		try {
			await Promise.all([targetMutation.$connect(), pointerMutation.$connect()]);
			await targetMutation.$executeRawUnsafe(`
				SET search_path TO ${quoted(schema)};
				BEGIN;
				UPDATE "assets" SET "original_name" = 'held-webgl.zip' WHERE "id" = 81105
			`);
			await expect(pointerMutation.$executeRawUnsafe(`
				SET search_path TO ${quoted(schema)};
				SET lock_timeout = '300ms';
				UPDATE "projects" SET "current_webgl_deployment_id" = 'deploy-1' WHERE "id" = 81001
			`)).rejects.toThrow(/lock timeout/);
		} finally {
			await targetMutation.$executeRawUnsafe('ROLLBACK').catch(() => undefined);
			await Promise.all([targetMutation.$disconnect(), pointerMutation.$disconnect()]);
		}
	});

	it('rejects a dirty fixture atomically before any contract DDL', async () => {
		const schema = await freshSchema('dirty');
		await applyMigrations(schema, phaseOneMigration);
		await control.$executeRawUnsafe(`
			INSERT INTO ${quoted(schema)}."users" ("google_sub", "email", "name", "picture", "created_at", "updated_at")
			VALUES ('dirty-observation', 'dirty@example.test', 'Dirty', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		`);
		await seedObservedMetrics(schema, 'CURRENT_TIMESTAMP');

		await expect(applyContract(schema)).rejects.toThrow(/lack a 24-hour zero observation/);

		const [catalog] = await control.$queryRawUnsafe<Array<{
			storageKeyStillPresent: boolean;
			legacySessionStillPresent: boolean;
			metricStillPresent: boolean;
			contractOwnerCheck: boolean;
			legacyCapabilityColumnStillPresent: boolean;
			canonicalCapabilityColumnPresent: boolean;
			legacyCapabilityIndexStillPresent: boolean;
		}>>(`
			SELECT
				EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = 'assets' AND column_name = 'storage_key') AS "storageKeyStillPresent",
				to_regclass('${schema}.game_upload_sessions') IS NOT NULL AS "legacySessionStillPresent",
				to_regclass('${schema}.migration_metrics') IS NOT NULL AS "metricStillPresent",
				EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema = '${schema}' AND table_name = 'assets' AND constraint_name = 'assets_owner_xor_check') AS "contractOwnerCheck",
				EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = 'asset_upload_sessions' AND column_name = 'part_url_issue_window_count') AS "legacyCapabilityColumnStillPresent",
				EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = 'asset_upload_sessions' AND column_name = 'part_capability_issued_count') AS "canonicalCapabilityColumnPresent",
				to_regclass('${schema}.asset_upload_sessions_part_url_issue_window_idx') IS NOT NULL AS "legacyCapabilityIndexStillPresent"
		`);
		expect(catalog).toEqual({
			storageKeyStillPresent: true,
			legacySessionStillPresent: true,
			metricStillPresent: true,
			contractOwnerCheck: false,
			legacyCapabilityColumnStillPresent: true,
			canonicalCapabilityColumnPresent: false,
			legacyCapabilityIndexStillPresent: true,
		});
	});

	it('waits for a concurrent mutation before starting the locked preflight', async () => {
		const schema = await freshSchema('lock');
		await applyMigrations(schema, phaseOneMigration);
		await control.$executeRawUnsafe(`
			INSERT INTO ${quoted(schema)}."users" ("id", "google_sub", "email", "name", "picture", "created_at", "updated_at")
			VALUES (83001, 'lock-holder', 'lock@example.test', 'Lock', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		`);
		await seedObservedMetrics(schema, `CURRENT_TIMESTAMP - INTERVAL '25 hours'`);
		const holder = createPrismaClientForDatabase(databaseUrl);
		try {
			await holder.$connect();
			await holder.$executeRawUnsafe(`
				SET search_path TO ${quoted(schema)};
				BEGIN;
				UPDATE "users" SET "name" = 'held' WHERE "id" = 83001
			`);
			await expect(applyContract(schema, `SET lock_timeout = '300ms';`)).rejects.toThrow(/lock timeout/);
		} finally {
			await holder.$executeRawUnsafe('ROLLBACK').catch(() => undefined);
			await holder.$disconnect();
		}
		const [catalog] = await control.$queryRawUnsafe<Array<{ legacyColumn: boolean; contractCheck: boolean }>>(`
			SELECT
				EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = 'assets' AND column_name = 'storage_key') AS "legacyColumn",
				EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema = '${schema}' AND table_name = 'assets' AND constraint_name = 'assets_owner_xor_check') AS "contractCheck"
		`);
		expect(catalog).toEqual({ legacyColumn: true, contractCheck: false });
	});
});
