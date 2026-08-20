BEGIN;

ALTER TABLE "game_upload_sessions"
  ADD COLUMN "expected_target_asset_id" INTEGER,
  ADD COLUMN "expected_target_asset_updated_at" TIMESTAMP(3);

-- A pre-migration in-flight session cannot be given a truthful creation-time
-- target snapshot. Drain it fail-closed instead of blessing whatever happens
-- to be READY at migration time.
CREATE TEMP TABLE "pre_fence_game_upload_sessions" ON COMMIT DROP AS
SELECT session."id", session."project_id", session."upload_kind", session."status",
  NULLIF(session."s3_key", '') AS "s3_key",
  NULLIF(session."storage_key", '') AS "storage_key",
  NULLIF(session."s3_upload_id", '') AS "s3_upload_id"
FROM "game_upload_sessions" AS session
WHERE session."status" IN ('PENDING', 'COMPLETING', 'VERIFYING');

DO $$
DECLARE blocker_count BIGINT;
BEGIN
  -- Every pre-fence row is being terminalized because its creation-time target
  -- cannot be reconstructed. Do not discard a multipart locator that cannot be
  -- copied into an exact abort task first.
  SELECT count(*) INTO blocker_count
  FROM "pre_fence_game_upload_sessions"
  WHERE "s3_upload_id" IS NOT NULL AND "s3_key" IS NULL;
  IF blocker_count > 0 THEN
    RAISE EXCEPTION
      'game upload target-fence migration blocked: % multipart upload ids have no exact key',
      blocker_count;
  END IF;

  -- PENDING/COMPLETING direct rows always own an in-progress multipart pair.
  -- A key without its upload ID is the inverse malformed locator: deleting a
  -- possible completed object would not prove that no multipart residue was
  -- stranded, so require operator repair instead of guessing.
  SELECT count(*) INTO blocker_count
  FROM "pre_fence_game_upload_sessions"
  WHERE "upload_kind" IN ('GAME'::"UploadKind", 'WEBGL'::"UploadKind")
    AND "status" IN ('PENDING', 'COMPLETING')
    AND ("s3_key" IS NULL OR "s3_upload_id" IS NULL);
  IF blocker_count > 0 THEN
    RAISE EXCEPTION
      'game upload target-fence migration blocked: % active multipart rows have incomplete exact locators',
      blocker_count;
  END IF;

  -- VERIFYING is reached only after Complete: the source key is retained,
  -- upload ID is cleared, and storage_key aliases that exact immutable object.
  SELECT count(*) INTO blocker_count
  FROM "pre_fence_game_upload_sessions" AS candidate
  WHERE candidate."status" = 'VERIFYING'
    AND (candidate."s3_key" IS NULL
      OR candidate."storage_key" IS NULL
      OR candidate."s3_upload_id" IS NOT NULL
      OR candidate."storage_key" <> candidate."s3_key");
  IF blocker_count > 0 THEN
    RAISE EXCEPTION
      'game upload target-fence migration blocked: % VERIFYING rows have conflicting exact locators',
      blocker_count;
  END IF;

  -- Before opaque deployment generations existed, the exact public WebGL
  -- prefix was derived from this canonical protected source key. A malformed
  -- key would make the public cleanup target unknowable.
  SELECT count(*) INTO blocker_count
  FROM "pre_fence_game_upload_sessions" AS candidate
  WHERE candidate."upload_kind" = 'WEBGL'::"UploadKind"
    AND candidate."s3_key" !~* format(
      '^webgl/%s/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/source[.]zip$',
      candidate."project_id"
    );
  IF blocker_count > 0 THEN
    RAISE EXCEPTION
      'game upload target-fence migration blocked: % WEBGL rows have malformed exact source locators',
      blocker_count;
  END IF;

  SELECT count(*) INTO blocker_count
  FROM "pre_fence_game_upload_sessions" AS candidate
  JOIN "assets" AS asset
    ON asset."status" = 'READY'::"AssetStatus"
   AND (asset."storage_key" = COALESCE(candidate."storage_key", candidate."s3_key")
     OR asset."playback_storage_key" = COALESCE(candidate."storage_key", candidate."s3_key"));
  IF blocker_count > 0 THEN
    RAISE EXCEPTION
      'game upload target-fence migration blocked: % in-flight source keys are READY asset references',
      blocker_count;
  END IF;
END $$;

INSERT INTO "multipart_abort_tasks" (
  "id", "bucket", "storage_key", "upload_id", "reason", "state",
  "attempt_count", "next_attempt_at", "created_at", "updated_at"
)
SELECT
  'target-fence-' || md5(candidate."s3_key" || chr(31) || candidate."s3_upload_id"),
  'pcu-protected', candidate."s3_key", candidate."s3_upload_id",
  'pre-target-fence-multipart-abort', 'PENDING'::"MultipartAbortTaskState",
  0, clock_timestamp(), clock_timestamp(), clock_timestamp()
FROM "pre_fence_game_upload_sessions" AS candidate
WHERE candidate."s3_key" IS NOT NULL AND candidate."s3_upload_id" IS NOT NULL
ON CONFLICT ("bucket", "storage_key", "upload_id") DO UPDATE
SET "reason" = EXCLUDED."reason";

UPDATE "multipart_abort_tasks" AS task
SET "state" = 'PENDING'::"MultipartAbortTaskState", "attempt_count" = 0,
    "next_attempt_at" = clock_timestamp(), "last_error" = NULL,
    "claim_token" = NULL, "claim_until" = NULL, "resolved_at" = NULL,
    "updated_at" = clock_timestamp()
FROM "pre_fence_game_upload_sessions" AS candidate
WHERE task."bucket" = 'pcu-protected'
  AND task."storage_key" = candidate."s3_key"
  AND task."upload_id" = candidate."s3_upload_id"
  AND (task."state" <> 'CLAIMED'::"MultipartAbortTaskState"
    OR task."claim_until" IS NULL OR task."claim_until" <= clock_timestamp());

CREATE TEMP TABLE "pre_fence_cleanup_targets" (
  "bucket" TEXT NOT NULL,
  "storage_key" TEXT NOT NULL,
  "target_kind" "OrphanTargetKind" NOT NULL,
  "reason" TEXT NOT NULL,
  PRIMARY KEY ("bucket", "storage_key")
) ON COMMIT DROP;

INSERT INTO "pre_fence_cleanup_targets"
SELECT DISTINCT 'pcu-protected', COALESCE(candidate."storage_key", candidate."s3_key"),
  'EXACT'::"OrphanTargetKind", 'pre-target-fence-source-cleanup'
FROM "pre_fence_game_upload_sessions" AS candidate
WHERE COALESCE(candidate."storage_key", candidate."s3_key") IS NOT NULL
ON CONFLICT DO NOTHING;

-- This is one immutable deployment generation, never a project-wide prefix.
INSERT INTO "pre_fence_cleanup_targets"
SELECT DISTINCT 'pcu-public',
  format('webgl/%s/%s/site/', candidate."project_id", parsed."deployment_id"),
  'PREFIX'::"OrphanTargetKind", 'pre-target-fence-webgl-generation-cleanup'
FROM "pre_fence_game_upload_sessions" AS candidate
CROSS JOIN LATERAL (
  SELECT (regexp_match(
    COALESCE(candidate."storage_key", candidate."s3_key", ''),
    format(
      '^webgl/%s/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/source[.]zip$',
      candidate."project_id"
    ), 'i'
  ))[1] AS "deployment_id"
) AS parsed
WHERE candidate."upload_kind" = 'WEBGL'::"UploadKind"
  AND parsed."deployment_id" IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO "orphan_objects" (
  "bucket", "storage_key", "reason", "target_kind", "state",
  "next_attempt_at", "attempt_count", "created_at"
)
SELECT target."bucket", target."storage_key", target."reason", target."target_kind",
  'PENDING'::"OrphanState", clock_timestamp(), 0, clock_timestamp()
FROM "pre_fence_cleanup_targets" AS target
ON CONFLICT ("bucket", "storage_key") DO UPDATE
SET "reason" = EXCLUDED."reason";

UPDATE "orphan_objects" AS orphan
SET "target_kind" = CASE WHEN orphan."state" = 'DELETE_CLAIMED'::"OrphanState"
        AND orphan."claim_until" > clock_timestamp()
      THEN orphan."target_kind" ELSE target."target_kind" END,
    "state" = CASE WHEN orphan."state" = 'DELETE_CLAIMED'::"OrphanState"
        AND orphan."claim_until" > clock_timestamp()
      THEN orphan."state" ELSE 'PENDING'::"OrphanState" END,
    "claim_token" = CASE WHEN orphan."state" = 'DELETE_CLAIMED'::"OrphanState"
        AND orphan."claim_until" > clock_timestamp()
      THEN orphan."claim_token" ELSE NULL END,
    "claim_until" = CASE WHEN orphan."state" = 'DELETE_CLAIMED'::"OrphanState"
        AND orphan."claim_until" > clock_timestamp()
      THEN orphan."claim_until" ELSE NULL END,
    "cancel_reason" = CASE WHEN orphan."state" = 'DELETE_CLAIMED'::"OrphanState"
        AND orphan."claim_until" > clock_timestamp()
      THEN 'business-outbox-requeue-requested' ELSE NULL END,
    "resolved_at" = CASE WHEN orphan."state" = 'DELETE_CLAIMED'::"OrphanState"
        AND orphan."claim_until" > clock_timestamp()
      THEN orphan."resolved_at" ELSE NULL END,
    "next_attempt_at" = clock_timestamp()
FROM "pre_fence_cleanup_targets" AS target
WHERE orphan."bucket" = target."bucket"
  AND orphan."storage_key" = target."storage_key";

DELETE FROM "game_upload_active_sessions" AS active
USING "pre_fence_game_upload_sessions" AS candidate
WHERE active."session_id" = candidate."id";

UPDATE "game_upload_sessions" AS session
SET "status" = 'REJECTED',
    "storage_key" = COALESCE(session."storage_key", session."s3_key"),
    "s3_key" = NULL, "s3_upload_id" = NULL,
    "completion_claim_token" = NULL, "completion_claim_until" = NULL,
    "completion_last_error" = 'PRE_TARGET_FENCE_SESSION_TERMINALIZED',
    "updated_at" = clock_timestamp()
FROM "pre_fence_game_upload_sessions" AS candidate
WHERE session."id" = candidate."id";

ALTER TABLE "game_upload_sessions"
  ADD CONSTRAINT "game_upload_expected_target_pair_check"
  CHECK (
    ("expected_target_asset_id" IS NULL AND "expected_target_asset_updated_at" IS NULL)
    OR ("expected_target_asset_id" IS NOT NULL AND "expected_target_asset_updated_at" IS NOT NULL)
  );

CREATE INDEX "game_upload_sessions_expected_target_asset_id_idx"
  ON "game_upload_sessions" ("expected_target_asset_id")
  WHERE "expected_target_asset_id" IS NOT NULL;

COMMIT;
