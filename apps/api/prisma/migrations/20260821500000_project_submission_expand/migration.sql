-- Additive publication aggregate. This migration is intentionally ordered
-- after canonical asset expand and before the destructive canonical contract.

CREATE TYPE "ProjectSubmissionState" AS ENUM (
  'PENDING',
  'PUBLISHED',
  'CANCELLED'
);

CREATE TYPE "ProjectSubmissionItemState" AS ENUM (
  'EXPECTED',
  'UPLOADING',
  'VERIFYING',
  'READY',
  'FAILED',
  'CANCELLED'
);

ALTER TABLE "projects" ALTER COLUMN "status" SET DEFAULT 'DRAFT'::"ProjectStatus";

CREATE TABLE "project_submissions" (
  "id" TEXT NOT NULL,
  "project_id" INTEGER NOT NULL,
  "actor_id" INTEGER NOT NULL,
  "state" "ProjectSubmissionState" NOT NULL DEFAULT 'PENDING',
  "published_at" TIMESTAMP(3),
  "cancelled_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_submissions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_submissions_project_id_key" UNIQUE ("project_id"),
  CONSTRAINT "project_submissions_id_project_id_key" UNIQUE ("id", "project_id"),
  CONSTRAINT "project_submissions_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "project_submissions_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "project_submissions_terminal_timestamps_check" CHECK (
    ("state" = 'PENDING' AND "published_at" IS NULL AND "cancelled_at" IS NULL)
    OR ("state" = 'PUBLISHED' AND "published_at" IS NOT NULL AND "cancelled_at" IS NULL)
    OR ("state" = 'CANCELLED' AND "published_at" IS NULL AND "cancelled_at" IS NOT NULL)
  )
);

CREATE INDEX "project_submissions_actor_state_idx"
  ON "project_submissions"("actor_id", "state");
CREATE INDEX "project_submissions_state_updated_at_idx"
  ON "project_submissions"("state", "updated_at");

CREATE TABLE "project_submission_items" (
  "id" TEXT NOT NULL,
  "submission_id" TEXT NOT NULL,
  "kind" "AssetUploadKind" NOT NULL,
  "slot" VARCHAR(80) NOT NULL,
  "client_token" VARCHAR(128) NOT NULL,
  "required" BOOLEAN NOT NULL DEFAULT TRUE,
  "state" "ProjectSubmissionItemState" NOT NULL DEFAULT 'EXPECTED',
  "bound_generation" INTEGER,
  "result_asset_id" INTEGER,
  "result_representation_id" TEXT,
  "result_webgl_deployment_id" TEXT,
  "failure_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_submission_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_submission_items_submission_id_slot_key" UNIQUE ("submission_id", "slot"),
  CONSTRAINT "project_submission_items_submission_id_client_token_key" UNIQUE ("submission_id", "client_token"),
  CONSTRAINT "project_submission_items_submission_id_fkey"
    FOREIGN KEY ("submission_id") REFERENCES "project_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "project_submission_items_result_asset_id_fkey"
    FOREIGN KEY ("result_asset_id") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "project_submission_items_result_representation_id_fkey"
    FOREIGN KEY ("result_representation_id") REFERENCES "asset_representations"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "project_submission_items_result_webgl_deployment_id_fkey"
    FOREIGN KEY ("result_webgl_deployment_id") REFERENCES "webgl_deployments"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "project_submission_items_slot_check" CHECK (
    "slot" ~ '^(game|webgl|poster|video:[0-9]+|image:[0-9]+)$'
  ),
  CONSTRAINT "project_submission_items_client_token_check" CHECK (
    "client_token" ~ '^[A-Za-z0-9_-]{32,128}$'
  ),
  CONSTRAINT "project_submission_items_generation_check" CHECK (
    "bound_generation" IS NULL OR "bound_generation" >= 1
  ),
  CONSTRAINT "project_submission_items_kind_slot_check" CHECK (
    ("kind" = 'GAME' AND "slot" = 'game')
    OR ("kind" = 'WEBGL' AND "slot" = 'webgl')
    OR ("kind" = 'POSTER' AND "slot" = 'poster')
    OR ("kind" = 'VIDEO' AND "slot" ~ '^video:[0-9]+$')
    OR ("kind" = 'IMAGE' AND "slot" ~ '^image:[0-9]+$')
  ),
  CONSTRAINT "project_submission_items_state_shape_check" CHECK (
    ("state" = 'EXPECTED' AND "bound_generation" IS NULL
      AND "result_asset_id" IS NULL AND "result_representation_id" IS NULL
      AND "result_webgl_deployment_id" IS NULL AND "failure_reason" IS NULL)
    OR ("state" IN ('UPLOADING', 'VERIFYING') AND "bound_generation" IS NOT NULL
      AND "result_asset_id" IS NULL AND "result_representation_id" IS NULL
      AND "result_webgl_deployment_id" IS NULL AND "failure_reason" IS NULL)
    -- READY identity shape is established by the upload trigger and rechecked
    -- by finalize. Later project/asset deletion may SET NULL these historical
    -- pointers in separate FK actions, so the row check must permit that cleanup.
    OR ("state" = 'READY' AND "bound_generation" IS NOT NULL
      AND "failure_reason" IS NULL)
    OR ("state" IN ('FAILED', 'CANCELLED')
      AND "result_asset_id" IS NULL AND "result_representation_id" IS NULL
      AND "result_webgl_deployment_id" IS NULL)
  )
);

CREATE INDEX "project_submission_items_submission_state_idx"
  ON "project_submission_items"("submission_id", "state");
CREATE INDEX "project_submission_items_result_asset_idx"
  ON "project_submission_items"("result_asset_id");
CREATE INDEX "project_submission_items_result_representation_idx"
  ON "project_submission_items"("result_representation_id");
CREATE INDEX "project_submission_items_result_webgl_idx"
  ON "project_submission_items"("result_webgl_deployment_id");

ALTER TABLE "asset_upload_sessions"
  ADD COLUMN "submission_item_id" TEXT;
ALTER TABLE "asset_upload_sessions"
  ADD CONSTRAINT "asset_upload_sessions_submission_item_id_key" UNIQUE ("submission_item_id");
ALTER TABLE "asset_upload_sessions"
  ADD CONSTRAINT "asset_upload_sessions_submission_item_id_fkey"
  FOREIGN KEY ("submission_item_id") REFERENCES "project_submission_items"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "sync_project_submission_item_from_upload"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $submission_item_sync$
DECLARE
  item RECORD;
  deployment_id TEXT;
  next_state "ProjectSubmissionItemState";
BEGIN
  IF NEW."submission_item_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT i.*, s."project_id", s."actor_id" AS "submission_actor_id",
    s."state" AS "submission_state"
  INTO item
  FROM "project_submission_items" i
  JOIN "project_submissions" s ON s."id" = i."submission_id"
  WHERE i."id" = NEW."submission_item_id"
  FOR UPDATE OF i, s;

  IF NOT FOUND
     OR NEW."project_id" IS NULL
     OR NEW."exhibition_id" IS NOT NULL
     OR item."project_id" <> NEW."project_id"
     OR item."submission_actor_id" <> NEW."user_id"
     OR item."kind" <> NEW."kind"
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'upload session does not match an active project submission item';
  END IF;

  -- Publication freezes the aggregate. Later FK cleanup may null historical
  -- result pointers on the upload row; do not reopen or rewrite its item.
  IF item."submission_state" <> 'PENDING' THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'cannot bind an upload to a terminal project submission';
    END IF;
    RETURN NEW;
  END IF;

  IF item."bound_generation" IS NULL THEN
    IF item."state" <> 'EXPECTED' THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'project submission item is already bound';
    END IF;
  ELSIF item."bound_generation" <> NEW."generation" THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'project submission upload generation fence was lost';
  END IF;

  IF NEW."state" IN ('ALLOCATING', 'UPLOADING', 'COMPLETING') THEN
    next_state := 'UPLOADING';
  ELSIF NEW."state" = 'VERIFYING' THEN
    next_state := 'VERIFYING';
  ELSIF NEW."state" = 'READY' THEN
    IF NEW."result_asset_id" IS NULL OR NEW."result_representation_id" IS NULL
       OR NOT EXISTS (
         SELECT 1
         FROM "assets" a
         JOIN "asset_representations" r
           ON r."id" = NEW."result_representation_id" AND r."asset_id" = a."id"
         WHERE a."id" = NEW."result_asset_id"
           AND a."project_id" = NEW."project_id"
           AND a."kind"::text = NEW."kind"::text
           AND a."status" = 'READY'
           AND r."state" = 'READY'
           AND r."role"::text = CASE
             WHEN NEW."kind" = 'WEBGL' THEN 'WEBGL_SOURCE'
             ELSE 'ORIGINAL'
           END
       ) THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'READY submission upload lacks its fenced canonical result';
    END IF;

    deployment_id := NULL;
    IF NEW."kind" = 'VIDEO' AND NOT EXISTS (
      SELECT 1 FROM "asset_representations"
      WHERE "asset_id" = NEW."result_asset_id"
        AND "role" = 'PLAYBACK' AND "state" = 'READY'
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'READY VIDEO submission upload lacks playback';
    ELSIF NEW."kind" IN ('IMAGE', 'POSTER') AND (
      NOT EXISTS (SELECT 1 FROM "asset_representations" WHERE "asset_id" = NEW."result_asset_id" AND "role" = 'CARD_480' AND "state" = 'READY')
      OR NOT EXISTS (SELECT 1 FROM "asset_representations" WHERE "asset_id" = NEW."result_asset_id" AND "role" = 'DISPLAY_960' AND "state" = 'READY')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'READY image submission upload lacks renditions';
    ELSIF NEW."kind" = 'WEBGL' THEN
      SELECT d."id" INTO deployment_id
      FROM "webgl_deployments" d
      JOIN "projects" p ON p."id" = d."project_id"
      WHERE d."id" = NEW."reserved_webgl_deployment_id"
        AND d."project_id" = NEW."project_id"
        AND d."source_representation_id" = NEW."result_representation_id"
        AND d."state" = 'READY'
        AND p."current_webgl_deployment_id" = d."id";
      IF deployment_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'check_violation',
          MESSAGE = 'READY WEBGL submission upload lacks its current deployment';
      END IF;
    END IF;
    next_state := 'READY';
  ELSIF NEW."state" = 'REJECTED' THEN
    next_state := 'FAILED';
  ELSE
    next_state := 'CANCELLED';
  END IF;

  UPDATE "project_submission_items"
  SET "state" = next_state,
      "bound_generation" = NEW."generation",
      "result_asset_id" = CASE WHEN next_state = 'READY' THEN NEW."result_asset_id" ELSE NULL END,
      "result_representation_id" = CASE WHEN next_state = 'READY' THEN NEW."result_representation_id" ELSE NULL END,
      "result_webgl_deployment_id" = CASE WHEN next_state = 'READY' THEN deployment_id ELSE NULL END,
      "failure_reason" = CASE
        WHEN next_state = 'FAILED' THEN COALESCE(NEW."validation_error", 'upload rejected')
        WHEN next_state = 'CANCELLED' THEN 'upload cancelled or expired'
        ELSE NULL
      END,
      "updated_at" = CURRENT_TIMESTAMP
  WHERE "id" = NEW."submission_item_id";

  RETURN NEW;
END;
$submission_item_sync$;

CREATE TRIGGER "asset_upload_submission_item_sync"
AFTER INSERT OR UPDATE OF
  "state", "generation", "result_asset_id", "result_representation_id",
  "reserved_webgl_deployment_id", "validation_error"
ON "asset_upload_sessions"
FOR EACH ROW EXECUTE FUNCTION "sync_project_submission_item_from_upload"();
