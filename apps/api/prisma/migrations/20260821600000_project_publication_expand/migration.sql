CREATE TYPE "ProjectSubmissionPlaybackState" AS ENUM ('NONE', 'READY', 'FAILED');
CREATE TYPE "ProjectPublicationJobState" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TYPE "StorageVisibility" AS ENUM ('PROTECTED', 'PUBLIC');

-- Environment bucket names are deliberately not embedded in DDL. The release
-- control plane seeds this registry from S3_BUCKET_PROTECTED/S3_BUCKET_PUBLIC
-- after expand and verifies it before contract.
CREATE TABLE "storage_buckets" (
  "bucket" TEXT NOT NULL,
  "visibility" "StorageVisibility" NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "storage_buckets_pkey" PRIMARY KEY ("bucket"),
  CONSTRAINT "storage_buckets_visibility_key" UNIQUE ("visibility")
);

CREATE INDEX "storage_buckets_visibility_idx" ON "storage_buckets"("visibility");

ALTER TABLE "project_submissions"
  DROP CONSTRAINT "project_submissions_terminal_timestamps_check",
  ADD CONSTRAINT "project_submissions_terminal_timestamps_check" CHECK (
    ("state" IN ('PENDING', 'FINALIZING') AND "published_at" IS NULL AND "cancelled_at" IS NULL)
    OR ("state" = 'PUBLISHED' AND "published_at" IS NOT NULL AND "cancelled_at" IS NULL)
    OR ("state" = 'CANCELLED' AND "published_at" IS NULL AND "cancelled_at" IS NOT NULL)
  );

ALTER TABLE "asset_representations"
  ADD COLUMN "publication_bucket" TEXT,
  ADD COLUMN "publication_object_key" TEXT,
  ADD CONSTRAINT "asset_representations_publication_target_shape_check" CHECK (
    ("publication_bucket" IS NULL AND "publication_object_key" IS NULL)
    OR (btrim("publication_bucket") <> '' AND btrim("publication_object_key") <> '')
  );

CREATE UNIQUE INDEX "asset_representations_publication_target_key"
  ON "asset_representations"("publication_bucket", "publication_object_key")
  WHERE "publication_bucket" IS NOT NULL;

ALTER TABLE "webgl_deployments"
  ADD COLUMN "staging_bucket" TEXT,
  ADD COLUMN "staging_prefix" TEXT,
  ADD COLUMN "staging_entry_object_key" TEXT,
  ADD COLUMN "staging_object_manifest" JSONB,
  ADD CONSTRAINT "webgl_deployments_staging_shape_check" CHECK (
    ("staging_bucket" IS NULL AND "staging_prefix" IS NULL
      AND "staging_entry_object_key" IS NULL AND "staging_object_manifest" IS NULL)
    OR (btrim("staging_bucket") <> '' AND btrim("staging_prefix") <> ''
      AND "staging_prefix" LIKE '%/'
      AND "staging_entry_object_key" LIKE "staging_prefix" || '%'
      AND ("state" <> 'READY' OR "staging_object_manifest" IS NOT NULL))
  );

ALTER TABLE "project_submission_items"
  ADD COLUMN "playback_state" "ProjectSubmissionPlaybackState" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "playback_error" TEXT,
  ADD CONSTRAINT "project_submission_items_required_check" CHECK ("required"),
  DROP CONSTRAINT "project_submission_items_state_shape_check",
  ADD CONSTRAINT "project_submission_items_state_shape_check" CHECK (
    ("state" = 'EXPECTED' AND "bound_generation" IS NULL
      AND "result_asset_id" IS NULL AND "result_representation_id" IS NULL
      AND "result_webgl_deployment_id" IS NULL AND "failure_reason" IS NULL
      AND "playback_state" = 'NONE' AND "playback_error" IS NULL)
    OR ("state" IN ('UPLOADING', 'VERIFYING') AND "bound_generation" IS NOT NULL
      AND "result_asset_id" IS NULL AND "result_representation_id" IS NULL
      AND "result_webgl_deployment_id" IS NULL AND "failure_reason" IS NULL
      AND "playback_state" = 'NONE' AND "playback_error" IS NULL)
    OR ("state" = 'READY' AND "bound_generation" IS NOT NULL
      AND "failure_reason" IS NULL
      AND (("kind" = 'VIDEO' AND "playback_state" IN ('READY', 'FAILED')
            AND (("playback_state" = 'READY' AND "playback_error" IS NULL)
              OR ("playback_state" = 'FAILED' AND btrim(COALESCE("playback_error", '')) <> '')))
        OR ("kind" <> 'VIDEO' AND "playback_state" = 'NONE' AND "playback_error" IS NULL)))
    OR ("state" IN ('FAILED', 'CANCELLED')
      AND "result_asset_id" IS NULL AND "result_representation_id" IS NULL
      AND "result_webgl_deployment_id" IS NULL
      AND "playback_state" = 'NONE' AND "playback_error" IS NULL)
  );

CREATE TABLE "project_publication_jobs" (
  "id" TEXT NOT NULL,
  "project_id" INTEGER NOT NULL,
  "submission_id" TEXT NOT NULL,
  "state" "ProjectPublicationJobState" NOT NULL DEFAULT 'PENDING',
  "plan" JSONB NOT NULL,
  "claim_token" TEXT,
  "claim_until" TIMESTAMP(3),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_publication_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_publication_jobs_project_id_key" UNIQUE ("project_id"),
  CONSTRAINT "project_publication_jobs_submission_id_key" UNIQUE ("submission_id"),
  CONSTRAINT "project_publication_jobs_submission_id_project_id_key" UNIQUE ("submission_id", "project_id"),
  CONSTRAINT "project_publication_jobs_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "project_publication_jobs_submission_project_fkey"
    FOREIGN KEY ("submission_id", "project_id") REFERENCES "project_submissions"("id", "project_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "project_publication_jobs_state_shape_check" CHECK (
    ("state" = 'PENDING' AND "completed_at" IS NULL AND "claim_token" IS NULL)
    OR ("state" = 'PROCESSING' AND "completed_at" IS NULL AND "claim_token" IS NOT NULL AND "claim_until" IS NOT NULL)
    OR ("state" = 'COMPLETED' AND "completed_at" IS NOT NULL AND "claim_token" IS NULL AND "claim_until" IS NULL)
    OR ("state" IN ('FAILED', 'CANCELLED') AND "completed_at" IS NULL AND "claim_token" IS NULL AND "claim_until" IS NULL)
  )
);

CREATE INDEX "project_publication_jobs_claim_idx"
  ON "project_publication_jobs"("state", "claim_until", "created_at");

CREATE OR REPLACE FUNCTION "sync_project_submission_item_from_upload"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $submission_item_sync$
DECLARE
  item RECORD;
  deployment_id TEXT;
  next_state "ProjectSubmissionItemState";
  next_playback_state "ProjectSubmissionPlaybackState" := 'NONE';
  next_playback_error TEXT;
BEGIN
  IF NEW."submission_item_id" IS NULL THEN RETURN NEW; END IF;

  SELECT i.*, s."project_id", s."actor_id" AS "submission_actor_id",
    s."state" AS "submission_state"
  INTO item
  FROM "project_submission_items" i
  JOIN "project_submissions" s ON s."id" = i."submission_id"
  WHERE i."id" = NEW."submission_item_id"
  FOR UPDATE OF i, s;

  IF NOT FOUND OR NEW."project_id" IS NULL OR NEW."exhibition_id" IS NOT NULL
     OR item."project_id" <> NEW."project_id"
     OR item."submission_actor_id" <> NEW."user_id"
     OR item."kind" <> NEW."kind" THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'upload session does not match an active project submission item';
  END IF;

  IF item."submission_state" <> 'PENDING' THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'cannot bind an upload to a terminal project submission';
    END IF;
    RETURN NEW;
  END IF;

  IF item."bound_generation" IS NULL THEN
    IF item."state" <> 'EXPECTED' THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'project submission item is already bound';
    END IF;
  ELSIF item."bound_generation" <> NEW."generation" THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'project submission upload generation fence was lost';
  END IF;

  IF NEW."state" IN ('ALLOCATING', 'UPLOADING', 'COMPLETING') THEN
    next_state := 'UPLOADING';
  ELSIF NEW."state" = 'VERIFYING' THEN
    next_state := 'VERIFYING';
  ELSIF NEW."state" = 'READY' THEN
    IF NEW."result_asset_id" IS NULL OR NEW."result_representation_id" IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM "assets" a
         JOIN "asset_representations" r ON r."id" = NEW."result_representation_id" AND r."asset_id" = a."id"
         WHERE a."id" = NEW."result_asset_id" AND a."project_id" = NEW."project_id"
           AND a."kind"::text = NEW."kind"::text AND a."status" = 'READY'
           AND r."state" = 'READY'
           AND r."role"::text = CASE WHEN NEW."kind" = 'WEBGL' THEN 'WEBGL_SOURCE' ELSE 'ORIGINAL' END
       ) THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'READY submission upload lacks its fenced canonical result';
    END IF;

    deployment_id := NULL;
    IF NEW."kind" = 'VIDEO' THEN
      SELECT CASE r."state"
          WHEN 'READY' THEN 'READY'::"ProjectSubmissionPlaybackState"
          WHEN 'FAILED' THEN 'FAILED'::"ProjectSubmissionPlaybackState"
          ELSE NULL
        END, r."error"
      INTO next_playback_state, next_playback_error
      FROM "asset_representations" r
      WHERE r."asset_id" = NEW."result_asset_id" AND r."role" = 'PLAYBACK';
      IF next_playback_state IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'check_violation',
          MESSAGE = 'READY VIDEO submission upload has no terminal playback result';
      END IF;
      IF next_playback_state = 'FAILED' AND btrim(COALESCE(next_playback_error, '')) = '' THEN
        next_playback_error := 'playback generation failed';
      END IF;
    ELSIF NEW."kind" IN ('IMAGE', 'POSTER') AND (
      NOT EXISTS (SELECT 1 FROM "asset_representations" WHERE "asset_id" = NEW."result_asset_id" AND "role" = 'CARD_480' AND "state" = 'READY')
      OR NOT EXISTS (SELECT 1 FROM "asset_representations" WHERE "asset_id" = NEW."result_asset_id" AND "role" = 'DISPLAY_960' AND "state" = 'READY')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'READY image submission upload lacks renditions';
    ELSIF NEW."kind" = 'WEBGL' THEN
      SELECT d."id" INTO deployment_id
      FROM "webgl_deployments" d
      WHERE d."id" = NEW."reserved_webgl_deployment_id"
        AND d."project_id" = NEW."project_id"
        AND d."source_representation_id" = NEW."result_representation_id"
        AND d."state" = 'READY'
        AND ((d."staging_bucket" IS NOT NULL AND d."staging_object_manifest" IS NOT NULL)
          OR EXISTS (SELECT 1 FROM "projects" p
            WHERE p."id" = d."project_id" AND p."current_webgl_deployment_id" = d."id"));
      IF deployment_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'check_violation',
          MESSAGE = 'READY WEBGL submission upload lacks its staged or current deployment';
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
        ELSE NULL END,
      "playback_state" = CASE WHEN next_state = 'READY' AND NEW."kind" = 'VIDEO' THEN next_playback_state ELSE 'NONE' END,
      "playback_error" = CASE WHEN next_state = 'READY' AND NEW."kind" = 'VIDEO' AND next_playback_state = 'FAILED' THEN next_playback_error ELSE NULL END,
      "updated_at" = CURRENT_TIMESTAMP
  WHERE "id" = NEW."submission_item_id";

  RETURN NEW;
END;
$submission_item_sync$;
