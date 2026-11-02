-- Enum addition commits separately before it is referenced. Existing rows are unchanged.
BEGIN;
ALTER TABLE "file_access_tokens" ADD COLUMN "review_id" TEXT;
CREATE TABLE "build_reviews" (
 "id" TEXT PRIMARY KEY, "session_id" TEXT NOT NULL REFERENCES "asset_upload_sessions"("id") ON DELETE CASCADE,
 "generation" INTEGER NOT NULL, "source_identity" TEXT NOT NULL, "validator_version" TEXT NOT NULL,
 "inspection" JSONB NOT NULL, "decision" TEXT NOT NULL DEFAULT 'PENDING', "version" INTEGER NOT NULL DEFAULT 1,
 "decided_by" INTEGER, "reason" TEXT, "entry_path" TEXT, "decided_at" TIMESTAMP(3),
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "build_reviews_decision_check" CHECK ("decision" IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
 CONSTRAINT "build_reviews_generation_check" CHECK ("generation" > 0 AND "version" > 0)
);
CREATE UNIQUE INDEX "build_reviews_session_id_generation_key" ON "build_reviews"("session_id", "generation");
CREATE INDEX "build_reviews_decision_created_at_idx" ON "build_reviews"("decision", "created_at");
DROP INDEX "asset_upload_sessions_active_project_kind_key";
CREATE UNIQUE INDEX "asset_upload_sessions_active_project_kind_key" ON "asset_upload_sessions"("project_id", "kind")
 WHERE "project_id" IS NOT NULL AND "kind" NOT IN ('VIDEO','DOCUMENT','ATTACHMENT')
 AND "state" IN ('ALLOCATING','UPLOADING','COMPLETING','VERIFYING','AWAITING_REVIEW');
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
  ELSIF NEW."state" IN ('VERIFYING', 'AWAITING_REVIEW') THEN
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
COMMIT;
