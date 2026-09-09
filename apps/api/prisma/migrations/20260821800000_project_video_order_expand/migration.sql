-- Phase 1 (additive): give every existing project video a deterministic
-- presentation slot. The nullable column remains readable by the prior Phase 1
-- runtime, while new writers can reserve slots 0..4.
--
-- A bad legacy owner or more than five READY videos must halt deployment rather
-- than silently choosing a main video or discarding a row. PostgreSQL DDL and
-- the backfill share this transaction, so a failed precondition leaves no
-- column, constraint, index, or rewritten asset row behind.
BEGIN;

ALTER TABLE "assets"
  ADD COLUMN "video_sort_order" INTEGER;

DO $project_video_order_preflight$
DECLARE
  invalid_owner_count BIGINT;
  over_capacity_project_count BIGINT;
BEGIN
  SELECT count(*) INTO invalid_owner_count
  FROM "assets"
  WHERE "kind" = 'VIDEO'
    AND "status" = 'READY'
    AND ("project_id" IS NULL OR "exhibition_id" IS NOT NULL);

  IF invalid_owner_count <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format(
        'project video order expand blocked: %s READY VIDEO assets are not project-owned exclusively',
        invalid_owner_count
      );
  END IF;

  SELECT count(*) INTO over_capacity_project_count
  FROM (
    SELECT "project_id"
    FROM "assets"
    WHERE "kind" = 'VIDEO' AND "status" = 'READY'
    GROUP BY "project_id"
    HAVING count(*) > 5
  ) over_capacity_projects;

  IF over_capacity_project_count <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format(
        'project video order expand blocked: %s projects have more than five READY VIDEO assets',
        over_capacity_project_count
      );
  END IF;
END
$project_video_order_preflight$;

-- `created_at, id` is a stable tie-breaker, including old imports that share
-- the same timestamp. Only READY legacy videos receive a presentation slot.
WITH ranked_videos AS (
  SELECT "id", row_number() OVER (
    PARTITION BY "project_id"
    ORDER BY "created_at" ASC, "id" ASC
  ) - 1 AS "video_sort_order"
  FROM "assets"
  WHERE "kind" = 'VIDEO'
    AND "status" = 'READY'
)
UPDATE "assets" asset
SET "video_sort_order" = ranked_videos."video_sort_order"
FROM ranked_videos
WHERE asset."id" = ranked_videos."id";

ALTER TABLE "assets"
  ADD CONSTRAINT "assets_video_sort_order_shape_check"
  CHECK (
    "video_sort_order" IS NULL
    OR (
      "video_sort_order" BETWEEN 0 AND 4
      AND "kind" = 'VIDEO'
      AND "project_id" IS NOT NULL
      AND "exhibition_id" IS NULL
    )
  );

-- The original active-session fence allowed only one active upload of every
-- kind per project. VIDEO now has five independent slots, so retain the exact
-- active-state/project-owner predicate for replace-only kinds while excluding
-- VIDEO. The session/result transaction remains responsible for reserving and
-- committing a specific video slot.
DROP INDEX "asset_upload_sessions_active_project_kind_key";

CREATE UNIQUE INDEX "asset_upload_sessions_active_project_kind_key"
  ON "asset_upload_sessions"("project_id", "kind")
  WHERE "project_id" IS NOT NULL
    AND "kind" <> 'VIDEO'
    AND "state" IN ('ALLOCATING', 'UPLOADING', 'COMPLETING', 'VERIFYING');

CREATE UNIQUE INDEX "asset_project_video_ready_order_unique"
  ON "assets" ("project_id", "video_sort_order")
  WHERE "status" = 'READY'
    AND "kind" = 'VIDEO'
    AND "video_sort_order" IS NOT NULL;

COMMIT;
