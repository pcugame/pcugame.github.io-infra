import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
	'../../prisma/migrations/20260822000000_canonical_asset_contract/migration.sql',
	import.meta.url,
);
const schemaUrl = new URL('../../prisma/schema.prisma', import.meta.url);
const submissionExpandUrl = new URL(
	'../../prisma/migrations/20260821500000_project_submission_expand/migration.sql',
	import.meta.url,
);

describe('canonical asset Phase 2 contract policy', () => {
	it('changes the project default only at the final contract boundary', async () => {
		const [expand, contract] = await Promise.all([
			readFile(submissionExpandUrl, 'utf8'),
			readFile(migrationUrl, 'utf8'),
		]);
		expect(expand).not.toContain('ALTER COLUMN "status" SET DEFAULT \'DRAFT\'');
		expect(contract).toContain('ALTER COLUMN "status" SET DEFAULT \'DRAFT\'::"ProjectStatus"');
	});

	it('runs every database-only gate before the first destructive statement', async () => {
		const sql = await readFile(migrationUrl, 'utf8');
		const preflightStart = sql.indexOf('DO $contract_preflight$');
		const preflightEnd = sql.indexOf('$contract_preflight$;', preflightStart + 1);
		const firstDrop = sql.search(/\bDROP (?:TABLE|TYPE|COLUMN)\b/);
		const lockStart = sql.indexOf('LOCK TABLE\n');

		expect(sql.trimStart().startsWith('-- Phase 2 (contract)')).toBe(true);
		expect(sql.indexOf('BEGIN;')).toBeLessThan(preflightStart);
		expect(lockStart).toBeGreaterThan(sql.indexOf('BEGIN;'));
		expect(lockStart).toBeLessThan(preflightStart);
		expect(sql.slice(lockStart, preflightStart)).toContain('IN ACCESS EXCLUSIVE MODE;');
		const lockSection = sql.slice(lockStart, preflightStart);
		for (const table of [
			'canonical_object_relocations', 'asset_representations', 'asset_upload_sessions', 'assets', 'exhibitions',
			'game_upload_active_sessions', 'game_upload_part_claims', 'game_upload_parts',
			'game_upload_sessions', 'migration_metrics', 'multipart_abort_tasks', 'orphan_objects',
			'project_publication_jobs', 'project_submission_items', 'project_submissions',
			'projects', 'storage_buckets', 'upload_intents', 'users', 'webgl_deployments',
		]) expect(lockSection).toContain(`"${table}"`);
		expect(preflightStart).toBeGreaterThan(0);
		expect(preflightEnd).toBeGreaterThan(preflightStart);
		expect(firstDrop).toBeGreaterThan(preflightEnd);
		expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);

		for (const evidence of [
			'FROM "migration_metrics"',
			'FROM "game_upload_sessions"',
			'FROM "game_upload_active_sessions"',
			'assets do not have exactly one owner',
			'non-terminal assets remain in flight',
			'READY assets lack their canonical source representation',
			'fallback metrics are missing, non-zero, or lack a 24-hour zero observation',
			'READY image assets lack canonical renditions',
			'exhibition poster pointers are unresolved',
			'physical objects have multiple asset owners',
			'malformed WebGL deployments',
			'project WebGL pointers are unresolved',
		]) expect(sql).toContain(evidence);
		expect(sql).toContain('object relocations are not durably committed');
		expect(sql).toContain('committed relocations do not match a READY canonical destination');
		expect(sql).toContain('canonical-contract-relocation-source');
		expect(sql).toContain('deployment."object_manifest" -> \'objects\'');
		expect(sql).toContain('deployment."staging_object_manifest" -> \'objects\'');
		expect(sql).toContain('DROP TABLE "canonical_object_relocations"');
		expect(sql).not.toContain('READY videos lack playback representations');
	});

	it('removes compatibility-only schema but retains canonical durable cleanup locators', async () => {
		const [sql, schema] = await Promise.all([
			readFile(migrationUrl, 'utf8'),
			readFile(schemaUrl, 'utf8'),
		]);

		for (const model of [
			'MigrationMetric',
			'GameUploadSession',
			'GameUploadPart',
			'GameUploadPartClaim',
			'GameUploadActiveSession',
		]) expect(schema).not.toContain(`model ${model} {`);
		expect(schema).not.toContain('enum UploadKind {');
		expect(schema).not.toContain('enum AssetPlaybackStatus {');

		const assetModel = schema.match(/model Asset \{[\s\S]*?\n\}/)?.[0] ?? '';
		for (const field of [
			'storageKey', 'playbackStorageKey', 'mimeType', 'playbackMimeType',
			'sizeBytes', 'playbackSizeBytes', 'card480Height', 'display960Height',
			'playbackStatus', 'playbackError', 'isPublic',
		]) expect(assetModel).not.toContain(field);
		expect(assetModel).toContain('originalName');
		expect(assetModel).toContain('representations');

		expect(schema).not.toContain('webglEntryKey');
		expect(schema).not.toContain('posterStorageKey');
		expect(schema).not.toContain('model MigrationMetric');
		expect(schema).toContain('@@unique([publicBucket, publicPrefix], name: "webgl_deployment_public_namespace", map: "webgl_deployments_public_bucket_prefix_key")');
		expect(schema).toMatch(/model MultipartAbortTask \{[\s\S]*uploadSessionId\s+String\?/);
		expect(schema).toMatch(/model MultipartAbortTask \{[\s\S]*uploadSession\s+AssetUploadSession\?/);
		expect(schema).toContain('@@unique([id, projectId], name: "project_submission_identity", map: "project_submissions_id_project_id_key")');
		expect(schema).toContain('@@unique([submissionId, projectId], name: "project_publication_job_submission_identity", map: "project_publication_jobs_submission_id_project_id_key")');
			expect(schema).toContain('submission ProjectSubmission @relation(fields: [submissionId, projectId], references: [id, projectId]');
		expect(schema).toContain('enum StorageVisibility');
		expect(schema).toContain('model StorageBucket {');
		expect(schema).toContain('@unique(map: "storage_buckets_visibility_key")');
		expect(schema).toContain('@relation("AssetRepresentationBucket"');
		expect(schema).toContain('@relation("WebglDeploymentStagingBucket"');
		expect(schema).toMatch(/model AssetUploadSession \{[\s\S]*partCapabilityIssuedCount\s+Int\s+@default\(0\)\s+@map\("part_capability_issued_count"\)/);
		expect(schema).toMatch(/model AssetUploadSession \{[\s\S]*partCapabilityFirstIssuedAt\s+DateTime\?\s+@map\("part_capability_first_issued_at"\)/);
		expect(schema).toMatch(/model AssetUploadSession \{[\s\S]*partCapabilityLastIssuedAt\s+DateTime\?\s+@map\("part_capability_last_issued_at"\)/);
		expect(schema).not.toContain('partUrlIssueWindowCount');
		expect(schema).not.toContain('partUrlIssueWindowStartedAt');
		expect(schema).not.toContain('partUrlLastIssuedAt');
		expect(sql).toContain('DROP INDEX "asset_upload_sessions_part_url_issue_window_idx"');
		expect(sql).toContain('RENAME COLUMN "part_url_issue_window_count" TO "part_capability_issued_count"');
		expect(sql).toContain('RENAME COLUMN "part_url_issue_window_started_at" TO "part_capability_first_issued_at"');
		expect(sql).toContain('RENAME COLUMN "part_url_last_issued_at" TO "part_capability_last_issued_at"');
		expect(sql).toContain('TO "asset_upload_sessions_part_capability_issued_count_check"');
		expect(sql).not.toContain('DROP COLUMN "upload_session_id"');
	});

	it('enforces canonical ownership and WebGL cross-row invariants after cutover', async () => {
		const sql = await readFile(migrationUrl, 'utf8');

		expect(sql).toContain('CONSTRAINT "assets_owner_xor_check"');
		expect(sql).toContain('CREATE CONSTRAINT TRIGGER "assets_canonical_ready_guard"');
		expect(sql).toContain('CREATE TRIGGER "asset_representations_distinct_owner_guard"');
		expect(sql).toContain('pg_advisory_xact_lock');
		expect(sql).toContain('existing."asset_id" <> NEW."asset_id"');
		expect(sql).toContain('CREATE CONSTRAINT TRIGGER "webgl_deployments_canonical_guard"');
		expect(sql).toContain('CREATE UNIQUE INDEX "webgl_deployments_public_bucket_prefix_key"');
		expect(sql).toContain('CREATE TRIGGER "webgl_deployments_public_namespace_guard"');
		expect(sql).toContain('CREATE CONSTRAINT TRIGGER "asset_representations_webgl_source_guard"');
		expect(sql).toContain('CREATE CONSTRAINT TRIGGER "assets_webgl_source_owner_guard"');
		expect(sql).toContain('CREATE CONSTRAINT TRIGGER "projects_canonical_pointer_guard"');
		expect(sql).toContain('CREATE CONSTRAINT TRIGGER "exhibitions_canonical_pointer_guard"');
		expect(sql).toContain('CREATE TRIGGER "assets_pointer_serialization"');
		expect(sql).toContain('CREATE TRIGGER "asset_representations_pointer_serialization"');
		expect(sql).toContain('CREATE TRIGGER "webgl_deployments_pointer_serialization"');
		expect(sql).toContain('CREATE TRIGGER "projects_pointer_serialization"');
		expect(sql).toContain('CREATE FUNCTION "canonical_assert_asset_dependents"');
		expect(sql).toContain("source_asset_kind <> 'WEBGL'");
		expect(sql).toContain("r.\"role\"::text <> 'WEBGL_SOURCE'");
		expect(sql).toContain("d.\"object_manifest\" ->> 'version' <> '1'");
		expect(sql).toContain('d."staging_object_manifest" ->> \'version\' <> \'1\'');
		expect(sql).toContain('object ->> \'checksumSha256\' !~* \'^[a-f0-9]{64}$\'');
		expect(sql).toContain('deployment."staging_bucket" IS NOT NULL');
		expect(sql).toContain('deployment."object_manifest" IS NOT NULL');
		expect(sql).toContain('deployment_staging_bucket IS NOT NULL OR deployment_object_manifest IS NULL');
		expect(sql).toContain('READY staged WebGL deployment requires a complete checksummed staging manifest');
		expect(sql).toContain('READY public WebGL deployment requires a complete immutable object manifest');
		expect(sql).toContain('CREATE FUNCTION "canonical_lock_project_ids"');
		expect(sql).toContain('CREATE FUNCTION "canonical_assert_project_publication"');
		expect(sql).toContain('CREATE TRIGGER "projects_publication_state_transition"');
		expect(sql).toContain('CREATE CONSTRAINT TRIGGER "project_submissions_publication_guard"');
		expect(sql).toContain('CONSTRAINT "asset_representations_bucket_fkey"');
		expect(sql).toContain('CONSTRAINT "webgl_deployments_staging_bucket_fkey"');
		expect(sql).toContain('CREATE CONSTRAINT TRIGGER "storage_buckets_publication_guard"');
		expect(sql).toContain('physical bucket identities are absent from the visibility registry');
		expect(sql).toContain("visibility\"::text IS DISTINCT FROM 'PROTECTED'");
		expect(sql).toContain('DRAFT project image representations must remain in UUID-scoped protected publication staging');
		expect(sql.match(/r\."object_key" NOT LIKE 'protected\/publication-staging\/projects\/'/g)).toHaveLength(2);
		expect(sql.match(/r\."object_key" !~ '\^protected\/publication-staging\/projects\//g)).toHaveLength(2);
		expect(sql.match(/r\."object_key" NOT LIKE 'public\/images\/%'/g)).toHaveLength(4);
		expect(sql).toContain('PUBLISHED project image representations cannot return to protected staging');
		expect(sql).toContain('exhibition poster representations must remain in the public image namespace');
		expect(sql).toContain('PUBLISHED project WebGL deployments cannot return to protected staging');
	});
});
