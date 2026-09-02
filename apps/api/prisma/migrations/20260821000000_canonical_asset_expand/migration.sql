-- Phase 1 (expand): introduce canonical domain/physical object identity while
-- retaining every legacy column and route dependency for dual-read cutover.
-- Ownership XORs, NOT NULL constraints, and legacy removal belong to Phase 2.
BEGIN;

CREATE TYPE "AssetRepresentationRole" AS ENUM (
  'ORIGINAL',
  'PLAYBACK',
  'CARD_480',
  'DISPLAY_960',
  'WEBGL_SOURCE'
);

CREATE TYPE "AssetRepresentationState" AS ENUM (
  'PENDING',
  'VERIFYING',
  'READY',
  'FAILED',
  'DELETING',
  'DELETED'
);

CREATE TYPE "WebglDeploymentState" AS ENUM (
  'PENDING',
  'PROCESSING',
  'READY',
  'FAILED',
  'DELETING',
  'DELETED'
);

CREATE TYPE "AssetUploadKind" AS ENUM (
  'GAME',
  'WEBGL',
  'VIDEO',
  'IMAGE',
  'POSTER'
);

CREATE TYPE "AssetUploadSessionState" AS ENUM (
  'ALLOCATING',
  'UPLOADING',
  'COMPLETING',
  'VERIFYING',
  'READY',
  'REJECTED',
  'CANCELLED',
  'EXPIRED'
);

CREATE TYPE "ExportJobState" AS ENUM (
  'QUEUED',
  'RUNNING',
  'READY',
  'FAILED',
  'CANCELLED'
);

-- New canonical writes can represent worker-owned lifecycle states and WebGL
-- sources without overloading a legacy kind or status.
ALTER TYPE "AssetKind" ADD VALUE 'WEBGL';
ALTER TYPE "AssetStatus" ADD VALUE 'PENDING';
ALTER TYPE "AssetStatus" ADD VALUE 'VERIFYING';
ALTER TYPE "AssetStatus" ADD VALUE 'PROCESSING';

-- Exhibition posters become canonical assets during backfill. Existing project
-- assets remain valid, and Phase 1 intentionally permits either owner to be
-- absent until reconciliation has completed.
ALTER TABLE "assets"
  ALTER COLUMN "project_id" DROP NOT NULL,
  ALTER COLUMN "storage_key" DROP NOT NULL,
  ADD COLUMN "exhibition_id" INTEGER;

ALTER TABLE "assets"
  ADD CONSTRAINT "assets_exhibition_id_fkey"
  FOREIGN KEY ("exhibition_id") REFERENCES "exhibitions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "assets_exhibition_id_kind_status_idx"
  ON "assets"("exhibition_id", "kind", "status");

CREATE TABLE "asset_representations" (
  "id" TEXT NOT NULL,
  "asset_id" INTEGER NOT NULL,
  "role" "AssetRepresentationRole" NOT NULL,
  "bucket" TEXT NOT NULL,
  "object_key" TEXT NOT NULL,
  "mime_type" TEXT NOT NULL DEFAULT '',
  "size_bytes" BIGINT NOT NULL DEFAULT 0,
  "checksum_algorithm" TEXT,
  "checksum" TEXT,
  "etag" TEXT,
  "source_identity_algorithm" TEXT,
  "source_identity" TEXT,
  "state" "AssetRepresentationState" NOT NULL DEFAULT 'PENDING',
  "error" TEXT,
  "width" INTEGER,
  "height" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "asset_representations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "asset_representations_asset_id_fkey"
    FOREIGN KEY ("asset_id") REFERENCES "assets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- One canonical role per domain asset is safe during expand. Physical object
-- ownership is deliberately an audit index, not a uniqueness constraint: the
-- backfill must report and reconcile duplicate legacy ownership before Phase 2.
CREATE UNIQUE INDEX "asset_representations_asset_id_role_key"
  ON "asset_representations"("asset_id", "role");
CREATE INDEX "asset_representations_bucket_object_key_idx"
  ON "asset_representations"("bucket", "object_key");
CREATE INDEX "asset_representations_state_idx"
  ON "asset_representations"("state");
CREATE INDEX "asset_representations_source_identity_idx"
  ON "asset_representations"("source_identity_algorithm", "source_identity");

-- Keep the legacy exhibition poster scalars readable while installing a
-- nullable canonical current-asset pointer for dual-read cutover.
ALTER TABLE "exhibitions"
  ADD COLUMN "poster_asset_id" INTEGER;

CREATE UNIQUE INDEX "exhibitions_poster_asset_id_key"
  ON "exhibitions"("poster_asset_id");

ALTER TABLE "exhibitions"
  ADD CONSTRAINT "exhibitions_poster_asset_id_fkey"
  FOREIGN KEY ("poster_asset_id") REFERENCES "assets"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "webgl_deployments" (
  "id" TEXT NOT NULL,
  "project_id" INTEGER NOT NULL,
  "source_representation_id" TEXT NOT NULL,
  "public_bucket" TEXT NOT NULL,
  "public_prefix" TEXT NOT NULL,
  "entry_object_key" TEXT NOT NULL,
  "object_manifest" JSONB,
  "state" "WebglDeploymentState" NOT NULL DEFAULT 'PENDING',
  "error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "webgl_deployments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "webgl_deployments_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "webgl_deployments_source_representation_id_fkey"
    FOREIGN KEY ("source_representation_id") REFERENCES "asset_representations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "webgl_deployments_project_id_state_idx"
  ON "webgl_deployments"("project_id", "state");
CREATE INDEX "webgl_deployments_source_representation_id_idx"
  ON "webgl_deployments"("source_representation_id");
CREATE INDEX "webgl_deployments_public_bucket_prefix_idx"
  ON "webgl_deployments"("public_bucket", "public_prefix");

-- The nullable pointer is added only after the target table exists. Its unique
-- index prevents one immutable deployment from becoming current for two projects
-- while permitting every legacy project to remain unset through backfill.
ALTER TABLE "projects"
  ADD COLUMN "current_webgl_deployment_id" TEXT;

CREATE UNIQUE INDEX "projects_current_webgl_deployment_id_key"
  ON "projects"("current_webgl_deployment_id");

ALTER TABLE "projects"
  ADD CONSTRAINT "projects_current_webgl_deployment_id_fkey"
  FOREIGN KEY ("current_webgl_deployment_id") REFERENCES "webgl_deployments"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Durable counters/gauges make temporary legacy fallbacks observable across
-- process restarts. Scope is a stable structured discriminator chosen by callers.
CREATE TABLE "migration_metrics" (
  "name" TEXT NOT NULL,
  "scope" TEXT NOT NULL DEFAULT '',
  "value" BIGINT NOT NULL DEFAULT 0,
  "last_observed_at" TIMESTAMP(3),
  "details" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "migration_metrics_pkey" PRIMARY KEY ("name", "scope")
);

-- Generic direct multipart control-plane state. Garage ListParts remains the
-- authoritative part inventory, so Phase 1 deliberately adds no chunk table.
CREATE TABLE "asset_upload_sessions" (
  "id" TEXT NOT NULL,
  "project_id" INTEGER,
  "exhibition_id" INTEGER,
  "user_id" INTEGER NOT NULL,
  "kind" "AssetUploadKind" NOT NULL,
  "state" "AssetUploadSessionState" NOT NULL DEFAULT 'ALLOCATING',
  "original_name" TEXT NOT NULL,
  "declared_mime_type" TEXT NOT NULL DEFAULT '',
  "total_bytes" BIGINT NOT NULL,
  "part_size_bytes" INTEGER NOT NULL,
  "total_parts" INTEGER NOT NULL,
  "bucket" TEXT NOT NULL,
  "object_key" TEXT NOT NULL,
  "upload_id" TEXT,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "part_url_issue_window_count" INTEGER NOT NULL DEFAULT 0,
  "part_url_issue_window_started_at" TIMESTAMP(3),
  "part_url_last_issued_at" TIMESTAMP(3),
  "source_identity_algorithm" TEXT NOT NULL,
  "source_identity" TEXT NOT NULL,
  "source_identity_block_size_bytes" INTEGER NOT NULL,
  "source_identity_block_manifest" JSONB NOT NULL,
  "completion_lease_token" TEXT,
  "completion_lease_until" TIMESTAMP(3),
  "completion_error" TEXT,
  "completion_result" JSONB,
  "validation_lease_token" TEXT,
  "validation_lease_until" TIMESTAMP(3),
  "validation_error" TEXT,
  "validation_attempt_count" INTEGER NOT NULL DEFAULT 0,
  "expected_target_asset_id" INTEGER,
  "expected_target_asset_updated_at" TIMESTAMP(3),
  "result_asset_id" INTEGER,
  "result_representation_id" TEXT,
  "reserved_webgl_deployment_id" TEXT,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "asset_upload_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "asset_upload_sessions_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "asset_upload_sessions_exhibition_id_fkey"
    FOREIGN KEY ("exhibition_id") REFERENCES "exhibitions"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "asset_upload_sessions_owner_xor_check"
    CHECK (("project_id" IS NOT NULL)::integer + ("exhibition_id" IS NOT NULL)::integer = 1),
  CONSTRAINT "asset_upload_sessions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "asset_upload_sessions_expected_target_asset_id_fkey"
    FOREIGN KEY ("expected_target_asset_id") REFERENCES "assets"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "asset_upload_sessions_result_asset_id_fkey"
    FOREIGN KEY ("result_asset_id") REFERENCES "assets"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "asset_upload_sessions_result_representation_id_fkey"
    FOREIGN KEY ("result_representation_id") REFERENCES "asset_representations"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "asset_upload_sessions_reserved_webgl_deployment_id_fkey"
    FOREIGN KEY ("reserved_webgl_deployment_id") REFERENCES "webgl_deployments"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "asset_upload_sessions_generation_check" CHECK ("generation" >= 1),
  CONSTRAINT "asset_upload_sessions_part_url_issue_window_count_check" CHECK ("part_url_issue_window_count" >= 0),
  CONSTRAINT "asset_upload_sessions_total_bytes_check" CHECK ("total_bytes" > 0),
  CONSTRAINT "asset_upload_sessions_part_size_bytes_check" CHECK ("part_size_bytes" > 0),
  CONSTRAINT "asset_upload_sessions_total_parts_check" CHECK ("total_parts" BETWEEN 1 AND 10000),
  CONSTRAINT "asset_upload_sessions_validation_attempt_count_check" CHECK ("validation_attempt_count" >= 0)
);

CREATE UNIQUE INDEX "asset_upload_sessions_result_asset_id_key"
  ON "asset_upload_sessions"("result_asset_id");
CREATE UNIQUE INDEX "asset_upload_sessions_result_representation_id_key"
  ON "asset_upload_sessions"("result_representation_id");
CREATE UNIQUE INDEX "asset_upload_sessions_reserved_webgl_deployment_id_key"
  ON "asset_upload_sessions"("reserved_webgl_deployment_id");
CREATE UNIQUE INDEX "asset_upload_sessions_active_project_kind_key"
  ON "asset_upload_sessions"("project_id", "kind")
  WHERE "project_id" IS NOT NULL
    AND "state" IN ('ALLOCATING', 'UPLOADING', 'COMPLETING', 'VERIFYING');
CREATE UNIQUE INDEX "asset_upload_sessions_active_exhibition_kind_key"
  ON "asset_upload_sessions"("exhibition_id", "kind")
  WHERE "exhibition_id" IS NOT NULL
    AND "state" IN ('ALLOCATING', 'UPLOADING', 'COMPLETING', 'VERIFYING');
CREATE INDEX "asset_upload_sessions_project_kind_state_idx"
  ON "asset_upload_sessions"("project_id", "kind", "state");
CREATE INDEX "asset_upload_sessions_exhibition_kind_state_idx"
  ON "asset_upload_sessions"("exhibition_id", "kind", "state");
CREATE INDEX "asset_upload_sessions_user_state_idx"
  ON "asset_upload_sessions"("user_id", "state");
CREATE INDEX "asset_upload_sessions_state_expires_at_idx"
  ON "asset_upload_sessions"("state", "expires_at");
CREATE INDEX "asset_upload_sessions_completion_recovery_idx"
  ON "asset_upload_sessions"("state", "completion_lease_until");
CREATE INDEX "asset_upload_sessions_validation_recovery_idx"
  ON "asset_upload_sessions"("state", "validation_lease_until");
CREATE INDEX "asset_upload_sessions_bucket_object_key_idx"
  ON "asset_upload_sessions"("bucket", "object_key");
CREATE INDEX "asset_upload_sessions_expected_target_fence_idx"
  ON "asset_upload_sessions"("expected_target_asset_id", "expected_target_asset_updated_at");
CREATE INDEX "asset_upload_sessions_part_url_issue_window_idx"
  ON "asset_upload_sessions"("user_id", "part_url_issue_window_started_at");

-- Abort retries retain the canonical session identity as well as the complete
-- Garage cleanup locator. SET NULL preserves the task after session cleanup.
ALTER TABLE "multipart_abort_tasks"
  ADD COLUMN "upload_session_id" TEXT;

ALTER TABLE "multipart_abort_tasks"
  ADD CONSTRAINT "multipart_abort_tasks_upload_session_id_fkey"
  FOREIGN KEY ("upload_session_id") REFERENCES "asset_upload_sessions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "multipart_abort_tasks_upload_session_id_idx"
  ON "multipart_abort_tasks"("upload_session_id");

-- Export requests are durable control-plane jobs. Object reads and NAS writes
-- are performed only by the independent export worker after a DB-clock lease.
CREATE TABLE "export_jobs" (
  "id" TEXT NOT NULL,
  "requested_by_id" INTEGER NOT NULL,
  "year" INTEGER,
  "dry_run" BOOLEAN NOT NULL DEFAULT false,
  "state" "ExportJobState" NOT NULL DEFAULT 'QUEUED',
  "snapshot" JSONB,
  "snapshot_hash" TEXT,
  "progress" JSONB,
  "result" JSONB,
  "error" TEXT,
  "claim_token" TEXT,
  "claim_until" TIMESTAMP(3),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 5,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "export_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "export_jobs_requested_by_id_fkey"
    FOREIGN KEY ("requested_by_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "export_jobs_year_check" CHECK ("year" IS NULL OR "year" >= 2000),
  CONSTRAINT "export_jobs_attempt_count_check" CHECK ("attempt_count" >= 0),
  CONSTRAINT "export_jobs_max_attempts_check" CHECK ("max_attempts" > 0)
);

CREATE UNIQUE INDEX "export_jobs_single_active_idx"
  ON "export_jobs" ((true))
  WHERE "state" IN ('QUEUED', 'RUNNING');
CREATE INDEX "export_jobs_claim_idx"
  ON "export_jobs"("state", "next_attempt_at", "created_at");
CREATE INDEX "export_jobs_claim_until_idx"
  ON "export_jobs"("claim_until");
CREATE INDEX "export_jobs_requested_by_created_at_idx"
  ON "export_jobs"("requested_by_id", "created_at");

COMMIT;
