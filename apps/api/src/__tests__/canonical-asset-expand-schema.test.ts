import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const expandMigrationUrl = new URL(
	'../../prisma/migrations/20260821000000_canonical_asset_expand/migration.sql',
	import.meta.url,
);
const prismaSchemaUrl = new URL('../../prisma/schema.prisma', import.meta.url);

describe('canonical asset Phase 1 expand schema', () => {
	it('is additive or nullable-loosening only and retains legacy identities', async () => {
		const sql = await readFile(expandMigrationUrl, 'utf8');

		expect(sql.trimStart().startsWith('-- Phase 1 (expand)')).toBe(true);
		expect(sql.indexOf('BEGIN;')).toBeLessThan(sql.indexOf('CREATE TYPE'));
		expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
		expect(sql).toContain('ALTER COLUMN "project_id" DROP NOT NULL');
		expect(sql).toContain('ALTER COLUMN "storage_key" DROP NOT NULL');
		expect(sql).not.toMatch(/DROP\s+(?:COLUMN|TABLE|TYPE)\b/i);
		expect(sql).not.toMatch(/\bUPDATE\s+"/i);
		expect(sql).not.toMatch(/\bDELETE\s+FROM\s+"/i);
		expect(sql).not.toMatch(/\bINSERT\s+INTO\s+"/i);
		expect(sql).not.toMatch(/DROP\s+.*(?:playback_storage_key|webgl_entry_key|poster_storage_key)/i);
	});

	it('separates domain assets, physical representations, and WebGL generations', async () => {
		const sql = await readFile(expandMigrationUrl, 'utf8');

		expect(sql).toContain('CREATE TABLE "asset_representations"');
		expect(sql).toContain('CREATE TABLE "webgl_deployments"');
		expect(sql).toContain('"object_manifest" JSONB');
		expect(sql).toContain('CREATE TABLE "migration_metrics"');
		expect(sql).toContain('"etag" TEXT');
		expect(sql).toContain('ADD COLUMN "poster_asset_id" INTEGER');
		expect(sql).toContain('ADD COLUMN "current_webgl_deployment_id" TEXT');
		expect(sql.indexOf('CREATE TABLE "webgl_deployments"')).toBeLessThan(
			sql.indexOf('ADD COLUMN "current_webgl_deployment_id" TEXT'),
		);
		expect(sql).toContain('CREATE UNIQUE INDEX "asset_representations_asset_id_role_key"');
		expect(sql).toContain('CREATE INDEX "asset_representations_bucket_object_key_idx"');
		expect(sql).not.toContain('CREATE UNIQUE INDEX "asset_representations_bucket_object_key_idx"');
	});

	it('models nullable Phase 1 owners and preserves legacy dual-read fields', async () => {
		const schema = await readFile(prismaSchemaUrl, 'utf8');

		expect(schema).toMatch(/enum AssetKind \{[\s\S]*\bWEBGL\b[\s\S]*\}/);
		expect(schema).toMatch(/model Asset \{[\s\S]*projectId\s+Int\?[\s\S]*exhibitionId\s+Int\?/);
		expect(schema).toMatch(/model Asset \{[\s\S]*storageKey\s+String\?/);
		expect(schema).toMatch(/model Exhibition \{[\s\S]*posterAssetId\s+Int\?/);
		expect(schema).toMatch(/model AssetRepresentation \{[\s\S]*etag\s+String\?/);
		expect(schema).toMatch(/model WebglDeployment \{[\s\S]*objectManifest\s+Json\?/);
		expect(schema).toContain('playbackStorageKey String?');
		expect(schema).toContain('webglEntryKey');
		expect(schema).toContain('posterStorageKey');
	});

	it('adds one generic direct multipart session without duplicating Garage part inventory', async () => {
		const [sql, schema] = await Promise.all([
			readFile(expandMigrationUrl, 'utf8'),
			readFile(prismaSchemaUrl, 'utf8'),
		]);

		expect(schema).toMatch(/enum AssetUploadKind \{[\s\S]*\bGAME\b[\s\S]*\bWEBGL\b[\s\S]*\bVIDEO\b[\s\S]*\bIMAGE\b[\s\S]*\bPOSTER\b[\s\S]*\}/);
		expect(schema).toMatch(/enum AssetUploadSessionState \{[\s\S]*ALLOCATING[\s\S]*UPLOADING[\s\S]*COMPLETING[\s\S]*VERIFYING[\s\S]*READY[\s\S]*REJECTED[\s\S]*CANCELLED[\s\S]*EXPIRED[\s\S]*\}/);
		expect(schema).toMatch(/model AssetUploadSession \{[\s\S]*sourceIdentityBlockManifest\s+Json[\s\S]*expectedTargetAssetUpdatedAt\s+DateTime\?[\s\S]*resultRepresentationId\s+String\?\s+@unique[\s\S]*reservedWebglDeploymentId\s+String\?\s+@unique/);
		expect(schema).toMatch(/partUrlIssueWindowCount\s+Int\s+@default\(0\)/);
		expect(schema).toMatch(/partUrlIssueWindowStartedAt\s+DateTime\?/);
		expect(schema).toMatch(/partUrlLastIssuedAt\s+DateTime\?/);
		expect(sql).toContain('CREATE TABLE "asset_upload_sessions"');
		expect(sql).toMatch(
			/CREATE TABLE "asset_upload_sessions" \([\s\S]*?"project_id" INTEGER,\s*"exhibition_id" INTEGER,/,
		);
		expect(sql).toMatch(
			/CREATE TABLE "webgl_deployments" \([\s\S]*?"project_id" INTEGER NOT NULL,[\s\S]*?CONSTRAINT "webgl_deployments_pkey"/,
		);
		expect(sql.match(/CREATE TABLE "webgl_deployments" \([\s\S]*?CONSTRAINT "webgl_deployments_pkey"/)?.[0]).not.toContain(
			'"exhibition_id"',
		);
		expect(sql).toContain('CREATE UNIQUE INDEX "asset_upload_sessions_active_project_kind_key"');
		expect(sql).toContain('CREATE UNIQUE INDEX "asset_upload_sessions_active_exhibition_kind_key"');
		expect(sql).toMatch(/AND "state" IN \('ALLOCATING', 'UPLOADING', 'COMPLETING', 'VERIFYING'\)/);
		expect(sql).toContain('CONSTRAINT "asset_upload_sessions_owner_xor_check"');
		expect(sql).toContain('FOREIGN KEY ("exhibition_id") REFERENCES "exhibitions"("id")');
		expect(schema).toMatch(/model AssetUploadSession \{[\s\S]*projectId\s+Int\?[\s\S]*exhibitionId\s+Int\?/);
		expect(schema).toMatch(/model Exhibition \{[\s\S]*assetUploads\s+AssetUploadSession\[\]/);
		expect(sql).toContain('CREATE INDEX "asset_upload_sessions_completion_recovery_idx"');
		expect(sql).toContain('CREATE INDEX "asset_upload_sessions_validation_recovery_idx"');
		expect(sql).toContain('CONSTRAINT "asset_upload_sessions_part_url_issue_window_count_check" CHECK ("part_url_issue_window_count" >= 0)');
		expect(sql).toContain('CREATE INDEX "asset_upload_sessions_part_url_issue_window_idx"');
		expect(sql).toContain('ADD COLUMN "upload_session_id" TEXT');
		expect(sql).not.toMatch(/CREATE TABLE "asset_upload_(?:parts|chunks)"/);
		expect(sql).not.toMatch(/ALTER TYPE "UploadKind" ADD VALUE 'VIDEO'/);
	});

	it('retains every legacy upload model unchanged for Phase 1 dual operation', async () => {
		const schema = await readFile(prismaSchemaUrl, 'utf8');
		for (const model of [
			'GameUploadSession',
			'GameUploadPart',
			'GameUploadPartClaim',
			'GameUploadActiveSession',
		]) {
			expect(schema).toContain(`model ${model} {`);
		}
		expect(schema).toMatch(/enum UploadKind \{\s*GAME\s*WEBGL\s*\}/);
	});

	it('adds a durable DB-clock leased export job without mutating legacy rows', async () => {
		const [sql, schema] = await Promise.all([
			readFile(expandMigrationUrl, 'utf8'),
			readFile(prismaSchemaUrl, 'utf8'),
		]);
		expect(schema).toMatch(/enum ExportJobState \{[\s\S]*QUEUED[\s\S]*RUNNING[\s\S]*READY[\s\S]*FAILED[\s\S]*CANCELLED[\s\S]*\}/);
		expect(schema).toMatch(/model ExportJob \{[\s\S]*snapshotHash\s+String\?[\s\S]*claimToken\s+String\?[\s\S]*claimUntil\s+DateTime\?[\s\S]*attemptCount\s+Int/);
		expect(sql).toContain('CREATE TABLE "export_jobs"');
		expect(sql).toContain('CREATE UNIQUE INDEX "export_jobs_single_active_idx"');
		expect(sql).toMatch(/WHERE "state" IN \('QUEUED', 'RUNNING'\)/);
		expect(sql).toContain('CREATE INDEX "export_jobs_claim_idx"');
		expect(sql).toContain('FOREIGN KEY ("requested_by_id") REFERENCES "users"("id")');
	});
});
