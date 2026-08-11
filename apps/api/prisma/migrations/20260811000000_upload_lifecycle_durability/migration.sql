-- Crash-safe object deletion, upload intents, idempotency, and multipart recovery.
CREATE TYPE "OrphanTargetKind" AS ENUM ('EXACT', 'PREFIX');
CREATE TYPE "OrphanState" AS ENUM ('PENDING', 'DELETE_CLAIMED', 'CANCELLED', 'RESOLVED');
CREATE TYPE "UploadIntentState" AS ENUM ('PREPARED', 'UPLOADED', 'COMMITTED', 'CLEANUP_QUEUED', 'RESOLVED');
CREATE TYPE "IdempotencyOperationState" AS ENUM ('IN_PROGRESS', 'SUCCEEDED', 'RETRYABLE_FAILED', 'TERMINAL_FAILED');
CREATE TYPE "MultipartAbortTaskState" AS ENUM ('PENDING', 'CLAIMED', 'RESOLVED');

ALTER TABLE "orphan_objects"
  ADD COLUMN "target_kind" "OrphanTargetKind" NOT NULL DEFAULT 'EXACT',
  ADD COLUMN "state" "OrphanState" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "claim_token" TEXT,
  ADD COLUMN "claim_until" TIMESTAMP(3),
  ADD COLUMN "cancel_reason" TEXT,
  ADD COLUMN "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "orphan_objects"
SET "target_kind" = CASE
  WHEN RIGHT("storage_key", 1) = '/' THEN 'PREFIX'::"OrphanTargetKind"
  ELSE 'EXACT'::"OrphanTargetKind"
END,
"state" = CASE
  WHEN "resolved_at" IS NULL THEN 'PENDING'::"OrphanState"
  ELSE 'RESOLVED'::"OrphanState"
END,
"next_attempt_at" = COALESCE("last_tried_at", "created_at", CURRENT_TIMESTAMP);

DROP INDEX IF EXISTS "orphan_objects_resolved_at_idx";
CREATE INDEX "orphan_objects_state_next_attempt_at_idx"
  ON "orphan_objects" ("state", "next_attempt_at");
CREATE INDEX "orphan_objects_claim_until_idx" ON "orphan_objects" ("claim_until");

ALTER TABLE "game_upload_sessions"
  ADD COLUMN "multipart_generation" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "completion_claim_token" TEXT,
  ADD COLUMN "completion_claim_until" TIMESTAMP(3),
  ADD COLUMN "completion_last_error" TEXT,
  ADD COLUMN "completion_result" JSONB;

ALTER TABLE "game_upload_parts"
  ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "game_upload_part_claims" (
  "id" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "part_number" INTEGER NOT NULL,
  "token" TEXT NOT NULL,
  "generation" INTEGER NOT NULL,
  "owner" TEXT NOT NULL DEFAULT '',
  "lease_until" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "game_upload_part_claims_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "game_upload_part_claims_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "game_upload_sessions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "game_upload_part_claims_token_key" ON "game_upload_part_claims"("token");
CREATE UNIQUE INDEX "game_upload_part_claim_session_part"
  ON "game_upload_part_claims"("session_id", "part_number");
CREATE INDEX "game_upload_part_claims_lease_until_idx" ON "game_upload_part_claims"("lease_until");

CREATE TABLE "upload_intents" (
  "id" TEXT NOT NULL,
  "bucket" TEXT NOT NULL,
  "storage_key" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "owner_operation_id" TEXT,
  "owner_actor_id" INTEGER,
  "owner_project_id" INTEGER,
  "owner_exhibition_id" INTEGER,
  "state" "UploadIntentState" NOT NULL DEFAULT 'PREPARED',
  "not_before" TIMESTAMP(3) NOT NULL,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_error" TEXT,
  "claim_token" TEXT,
  "claim_until" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "upload_intents_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "upload_intent_bucket_storage_key"
  ON "upload_intents"("bucket", "storage_key");
CREATE INDEX "upload_intents_state_next_attempt_at_not_before_idx"
  ON "upload_intents"("state", "next_attempt_at", "not_before");
CREATE INDEX "upload_intents_owner_operation_id_idx" ON "upload_intents"("owner_operation_id");

CREATE TABLE "idempotency_operations" (
  "id" TEXT NOT NULL,
  "actor_id" INTEGER NOT NULL,
  "scope" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "state" "IdempotencyOperationState" NOT NULL DEFAULT 'IN_PROGRESS',
  "owner_token" TEXT,
  "owner_until" TIMESTAMP(3),
  "result" JSONB,
  "last_error" TEXT,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "idempotency_operations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "idempotency_actor_scope_key"
  ON "idempotency_operations"("actor_id", "scope", "key");
CREATE INDEX "idempotency_operations_state_owner_until_idx"
  ON "idempotency_operations"("state", "owner_until");
CREATE INDEX "idempotency_operations_expires_at_idx" ON "idempotency_operations"("expires_at");

CREATE TABLE "multipart_abort_tasks" (
  "id" TEXT NOT NULL,
  "bucket" TEXT NOT NULL,
  "storage_key" TEXT NOT NULL,
  "upload_id" TEXT NOT NULL,
  "reason" TEXT NOT NULL DEFAULT '',
  "state" "MultipartAbortTaskState" NOT NULL DEFAULT 'PENDING',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_error" TEXT,
  "claim_token" TEXT,
  "claim_until" TIMESTAMP(3),
  "resolved_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "multipart_abort_tasks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "multipart_abort_bucket_key_upload"
  ON "multipart_abort_tasks"("bucket", "storage_key", "upload_id");
CREATE INDEX "multipart_abort_tasks_state_next_attempt_at_idx"
  ON "multipart_abort_tasks"("state", "next_attempt_at");
CREATE INDEX "multipart_abort_tasks_claim_until_idx" ON "multipart_abort_tasks"("claim_until");

-- S3 requires every non-final multipart part to be at least 5 MiB.
UPDATE "site_settings" SET "max_chunk_size_mb" = 5 WHERE "max_chunk_size_mb" < 5;
ALTER TABLE "site_settings"
  ADD CONSTRAINT "site_settings_max_chunk_size_mb_min_5" CHECK ("max_chunk_size_mb" >= 5);
