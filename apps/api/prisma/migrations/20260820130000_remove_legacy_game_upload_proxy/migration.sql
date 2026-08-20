-- Direct multipart is now the only GAME/WEBGL transport.  Before removing the
-- proxy-only schema, copy every exact legacy storage locator into the durable
-- cleanup outboxes.  Live domain pointer collisions suppress deletion while
-- still preserving the exact multipart abort; malformed provenance fails closed.
--
-- Historical rows do not record their bucket.  The original deployment used
-- the canonical pcu-protected/pcu-public namespaces.  The mandatory preflight
-- audit blocks this migration when an operator configured custom bucket names
-- and a legacy cleanup candidate exists, because SQL cannot reconstruct that
-- provenance safely.
BEGIN;

LOCK TABLE "game_upload_sessions" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "game_upload_active_sessions" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "assets" IN SHARE MODE;
LOCK TABLE "projects" IN SHARE MODE;
LOCK TABLE "upload_intents" IN SHARE MODE;
LOCK TABLE "orphan_objects" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "multipart_abort_tasks" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  blocker_count BIGINT;
BEGIN
  SELECT count(*) INTO blocker_count
  FROM "game_upload_sessions"
  WHERE "transport" = 'API_CHUNK_PROXY'::"GameUploadTransport"
    AND "status" = 'COMPLETED'
    AND NULLIF("storage_key", '') IS NOT NULL
    AND NULLIF("s3_key", '') IS NOT NULL
    AND "storage_key" <> "s3_key";
  IF blocker_count > 0 THEN
    RAISE EXCEPTION
      'legacy game-upload cutover blocked: % completed sessions have conflicting object locators',
      blocker_count;
  END IF;
END $$;

-- Some synchronous legacy completions retained only s3_key.  Normalize that
-- durable completed-object reference before the proxy locator is removed.
UPDATE "game_upload_sessions"
SET "storage_key" = NULLIF("s3_key", ''),
    "updated_at" = clock_timestamp()
WHERE "transport" = 'API_CHUNK_PROXY'::"GameUploadTransport"
  AND "status" = 'COMPLETED'
  AND NULLIF("storage_key", '') IS NULL
  AND NULLIF("s3_key", '') IS NOT NULL;

CREATE TEMP TABLE "legacy_game_upload_cutover_candidates" (
  "session_id" TEXT PRIMARY KEY,
  "project_id" INTEGER NOT NULL,
  "upload_kind" "UploadKind" NOT NULL,
  "status" TEXT NOT NULL,
  "s3_key" TEXT,
  "storage_key" TEXT,
  "s3_upload_id" TEXT
) ON COMMIT DROP;

INSERT INTO "legacy_game_upload_cutover_candidates" (
  "session_id", "project_id", "upload_kind", "status",
  "s3_key", "storage_key", "s3_upload_id"
)
SELECT
  "id", "project_id", "upload_kind", "status",
  NULLIF("s3_key", ''), NULLIF("storage_key", ''), NULLIF("s3_upload_id", '')
FROM "game_upload_sessions"
WHERE "transport" = 'API_CHUNK_PROXY'::"GameUploadTransport"
  AND "status" <> 'COMPLETED';

CREATE TEMP TABLE "legacy_game_upload_cutover_targets" (
  "bucket" TEXT NOT NULL,
  "storage_key" TEXT NOT NULL,
  "target_kind" "OrphanTargetKind" NOT NULL,
  "reason" TEXT NOT NULL,
  PRIMARY KEY ("bucket", "storage_key")
) ON COMMIT DROP;

-- A proxy row may have either alias populated after an ambiguous Complete.
-- Both are exact protected-object candidates; never substitute a broad prefix.
INSERT INTO "legacy_game_upload_cutover_targets" (
  "bucket", "storage_key", "target_kind", "reason"
)
SELECT DISTINCT
  'pcu-protected', locator."storage_key", 'EXACT'::"OrphanTargetKind",
  'legacy-game-upload-direct-cutover-object'
FROM "legacy_game_upload_cutover_candidates" AS candidate
CROSS JOIN LATERAL (
  VALUES (candidate."s3_key"), (candidate."storage_key")
) AS locator("storage_key")
WHERE locator."storage_key" IS NOT NULL
ON CONFLICT ("bucket", "storage_key") DO NOTHING;

-- A WebGL public deployment is safe to remove only when the immutable
-- generation can be derived exactly from the canonical protected source key.
INSERT INTO "legacy_game_upload_cutover_targets" (
  "bucket", "storage_key", "target_kind", "reason"
)
SELECT DISTINCT
  'pcu-public',
  format('webgl/%s/%s/site/', candidate."project_id", parsed."deployment_id"),
  'PREFIX'::"OrphanTargetKind",
  'legacy-game-upload-direct-cutover-webgl-generation'
FROM "legacy_game_upload_cutover_candidates" AS candidate
CROSS JOIN LATERAL (
  VALUES (candidate."s3_key"), (candidate."storage_key")
) AS locator("storage_key")
CROSS JOIN LATERAL (
  SELECT (regexp_match(
    locator."storage_key",
    format(
      '^webgl/%s/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/source[.]zip$',
      candidate."project_id"
    ),
    'i'
  ))[1] AS "deployment_id"
) AS parsed
WHERE candidate."upload_kind" = 'WEBGL'::"UploadKind"
  AND locator."storage_key" IS NOT NULL
  AND parsed."deployment_id" IS NOT NULL
ON CONFLICT ("bucket", "storage_key") DO NOTHING;

DO $$
DECLARE
  blocker_count BIGINT;
BEGIN
  -- An upload ID without its exact multipart key cannot be durably aborted.
  SELECT count(*) INTO blocker_count
  FROM "legacy_game_upload_cutover_candidates"
  WHERE "s3_upload_id" IS NOT NULL AND "s3_key" IS NULL;
  IF blocker_count > 0 THEN
    RAISE EXCEPTION
      'legacy game-upload cutover blocked: % multipart upload ids have no exact key',
      blocker_count;
  END IF;

  -- A malformed WebGL source could have emitted a public deployment, but its
  -- exact immutable public generation prefix cannot be reconstructed.
  SELECT count(DISTINCT candidate."session_id") INTO blocker_count
  FROM "legacy_game_upload_cutover_candidates" AS candidate
  CROSS JOIN LATERAL (
    VALUES (candidate."s3_key"), (candidate."storage_key")
  ) AS locator("storage_key")
  WHERE candidate."upload_kind" = 'WEBGL'::"UploadKind"
    AND locator."storage_key" IS NOT NULL
    AND locator."storage_key" !~* format(
      '^webgl/%s/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/source[.]zip$',
      candidate."project_id"
    );
  IF blocker_count > 0 THEN
    RAISE EXCEPTION
      'legacy game-upload cutover blocked: % WebGL sessions lack an exact generation key',
      blocker_count;
  END IF;

  -- If a public prefix will be deleted, any malformed live WebGL pointer makes
  -- the public bucket reference inventory unknowable and therefore unsafe.
  IF EXISTS (
    SELECT 1 FROM "legacy_game_upload_cutover_targets"
    WHERE "bucket" = 'pcu-public'
  ) THEN
    SELECT count(*) INTO blocker_count
    FROM "projects" AS project
    WHERE project."webgl_entry_key" <> ''
      AND project."webgl_entry_key" !~* format(
        '^webgl/%s/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/site/index[.]html$',
        project."id"
      );
    IF blocker_count > 0 THEN
      RAISE EXCEPTION
        'legacy game-upload cutover blocked: % malformed project WebGL pointers make public cleanup unsafe',
        blocker_count;
    END IF;

    SELECT count(*) INTO blocker_count
    FROM "game_upload_sessions" AS session
    WHERE session."transport" = 'DIRECT_MULTIPART'::"GameUploadTransport"
      AND session."upload_kind" = 'WEBGL'::"UploadKind"
      AND session."status" IN ('PENDING', 'COMPLETING', 'VERIFYING')
      AND COALESCE(session."storage_key", session."s3_key", '') <> ''
      AND COALESCE(session."storage_key", session."s3_key") !~* format(
        '^webgl/%s/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/source[.]zip$',
        session."project_id"
      );
    IF blocker_count > 0 THEN
      RAISE EXCEPTION
        'legacy game-upload cutover blocked: % malformed live direct WebGL pointers make public cleanup unsafe',
        blocker_count;
    END IF;
  END IF;
END $$;

-- Business pointers fence deletion but do not prevent cutover.  Multipart
-- abort remains exact and independent so an unfinished upload cannot survive.
CREATE TEMP TABLE "legacy_game_upload_cutover_collisions" (
  "bucket" TEXT NOT NULL,
  "storage_key" TEXT NOT NULL,
  "target_kind" "OrphanTargetKind" NOT NULL,
  "collision_kind" TEXT NOT NULL,
  PRIMARY KEY ("bucket", "storage_key", "collision_kind")
) ON COMMIT DROP;

INSERT INTO "legacy_game_upload_cutover_collisions"
SELECT DISTINCT target."bucket", target."storage_key", target."target_kind", 'READY_ASSET'
FROM "legacy_game_upload_cutover_targets" AS target
JOIN "assets" AS asset
  ON target."bucket" = CASE WHEN asset."is_public" THEN 'pcu-public' ELSE 'pcu-protected' END
 AND (
   (target."target_kind" = 'EXACT'::"OrphanTargetKind" AND (
     target."storage_key" = asset."storage_key"
     OR target."storage_key" = asset."playback_storage_key"
   )) OR
   (target."target_kind" = 'PREFIX'::"OrphanTargetKind" AND (
     asset."storage_key" LIKE target."storage_key" || '%'
     OR asset."playback_storage_key" LIKE target."storage_key" || '%'
   ))
 )
WHERE asset."status" = 'READY'::"AssetStatus"
ON CONFLICT DO NOTHING;

INSERT INTO "legacy_game_upload_cutover_collisions"
SELECT DISTINCT target."bucket", target."storage_key", target."target_kind", 'PROJECT_WEBGL'
FROM "projects" AS project
CROSS JOIN LATERAL (
  SELECT (regexp_match(
    project."webgl_entry_key",
    format(
      '^webgl/%s/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/site/index[.]html$',
      project."id"
    ), 'i'
  ))[1] AS "deployment_id"
) AS parsed
JOIN "legacy_game_upload_cutover_targets" AS target ON (
  target."bucket" = 'pcu-public'
  AND target."storage_key" = format('webgl/%s/%s/site/', project."id", parsed."deployment_id")
) OR (
  target."bucket" = 'pcu-protected'
  AND target."storage_key" = format('webgl/%s/%s/source.zip', project."id", parsed."deployment_id")
)
WHERE parsed."deployment_id" IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO "legacy_game_upload_cutover_collisions"
SELECT DISTINCT target."bucket", target."storage_key", target."target_kind", 'PRESERVED_SESSION'
FROM "game_upload_sessions" AS preserved
JOIN "legacy_game_upload_cutover_targets" AS target
  ON target."bucket" = 'pcu-protected'
 AND target."target_kind" = 'EXACT'::"OrphanTargetKind"
 AND (target."storage_key" = preserved."s3_key" OR target."storage_key" = preserved."storage_key")
WHERE NOT EXISTS (
  SELECT 1 FROM "legacy_game_upload_cutover_candidates" AS candidate
  WHERE candidate."session_id" = preserved."id"
)
ON CONFLICT DO NOTHING;

-- Preserve the public half of a canonical WebGL generation whenever a
-- preserved session owns its protected source.
INSERT INTO "legacy_game_upload_cutover_collisions"
SELECT DISTINCT target."bucket", target."storage_key", target."target_kind", 'PRESERVED_SESSION'
FROM "game_upload_sessions" AS preserved
CROSS JOIN LATERAL (
  VALUES (NULLIF(preserved."s3_key", '')), (NULLIF(preserved."storage_key", ''))
) AS locator("storage_key")
CROSS JOIN LATERAL (
  SELECT (regexp_match(
    locator."storage_key",
    format(
      '^webgl/%s/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/source[.]zip$',
      preserved."project_id"
    ), 'i'
  ))[1] AS "deployment_id"
) AS parsed
JOIN "legacy_game_upload_cutover_targets" AS target
  ON target."bucket" = 'pcu-public'
 AND target."storage_key" = format(
   'webgl/%s/%s/site/', preserved."project_id", parsed."deployment_id"
 )
WHERE parsed."deployment_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "legacy_game_upload_cutover_candidates" AS candidate
    WHERE candidate."session_id" = preserved."id"
  )
ON CONFLICT DO NOTHING;

INSERT INTO "legacy_game_upload_cutover_collisions"
SELECT DISTINCT target."bucket", target."storage_key", target."target_kind", 'LIVE_UPLOAD_INTENT'
FROM "upload_intents" AS intent
JOIN "legacy_game_upload_cutover_targets" AS target
  ON target."bucket" = intent."bucket"
 AND (
   (target."target_kind" = 'EXACT'::"OrphanTargetKind"
     AND target."storage_key" = intent."storage_key")
   OR
   (target."target_kind" = 'PREFIX'::"OrphanTargetKind"
     AND intent."storage_key" LIKE target."storage_key" || '%')
 )
WHERE intent."state" IN (
  'PREPARED'::"UploadIntentState",
  'UPLOADED'::"UploadIntentState",
  'COMMITTED'::"UploadIntentState"
)
ON CONFLICT DO NOTHING;

DO $$
DECLARE
  blocker_count BIGINT;
BEGIN
  -- Reusing a live outbox key with a different target kind could turn an exact
  -- cleanup into a prefix cleanup (or vice versa) while another worker owns it.
  SELECT count(*) INTO blocker_count
  FROM "orphan_objects" AS orphan
  JOIN "legacy_game_upload_cutover_targets" AS target
    ON target."bucket" = orphan."bucket"
   AND target."storage_key" = orphan."storage_key"
  WHERE orphan."state" = 'DELETE_CLAIMED'::"OrphanState"
    AND orphan."claim_until" > clock_timestamp()
    AND orphan."target_kind" <> target."target_kind";
  IF blocker_count > 0 THEN
    RAISE EXCEPTION
      'legacy game-upload cutover blocked: % active deletion claims have conflicting target kinds',
      blocker_count;
  END IF;
END $$;

DELETE FROM "legacy_game_upload_cutover_targets" AS target
USING "legacy_game_upload_cutover_collisions" AS collision
WHERE target."bucket" = collision."bucket"
  AND target."storage_key" = collision."storage_key";

CREATE TEMP TABLE "legacy_game_upload_cutover_aborts" (
  "bucket" TEXT NOT NULL,
  "storage_key" TEXT NOT NULL,
  "upload_id" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  PRIMARY KEY ("bucket", "storage_key", "upload_id")
) ON COMMIT DROP;

INSERT INTO "legacy_game_upload_cutover_aborts" (
  "bucket", "storage_key", "upload_id", "reason"
)
SELECT DISTINCT
  'pcu-protected', "s3_key", "s3_upload_id",
  'legacy-game-upload-direct-cutover-multipart'
FROM "legacy_game_upload_cutover_candidates"
WHERE "s3_key" IS NOT NULL AND "s3_upload_id" IS NOT NULL;

-- Match queueMultipartAbortTask: conflict is idempotent, an inactive claim is
-- rearmed, and a currently leased worker keeps ownership of its in-flight task.
INSERT INTO "multipart_abort_tasks" (
  "id", "bucket", "storage_key", "upload_id", "reason", "state",
  "attempt_count", "next_attempt_at", "created_at", "updated_at"
)
SELECT
  'legacy-cutover-' || md5(
    abort."bucket" || chr(31) || abort."storage_key" || chr(31) || abort."upload_id"
  ),
  abort."bucket", abort."storage_key", abort."upload_id", abort."reason",
  'PENDING'::"MultipartAbortTaskState", 0, clock_timestamp(),
  clock_timestamp(), clock_timestamp()
FROM "legacy_game_upload_cutover_aborts" AS abort
ON CONFLICT ("bucket", "storage_key", "upload_id") DO UPDATE
SET "reason" = EXCLUDED."reason";

UPDATE "multipart_abort_tasks" AS task
SET "state" = 'PENDING'::"MultipartAbortTaskState",
    "attempt_count" = 0,
    "next_attempt_at" = clock_timestamp(),
    "last_error" = NULL,
    "claim_token" = NULL,
    "claim_until" = NULL,
    "resolved_at" = NULL,
    "updated_at" = clock_timestamp()
FROM "legacy_game_upload_cutover_aborts" AS abort
WHERE task."bucket" = abort."bucket"
  AND task."storage_key" = abort."storage_key"
  AND task."upload_id" = abort."upload_id"
  AND (
    task."state" <> 'CLAIMED'::"MultipartAbortTaskState"
    OR task."claim_until" IS NULL
    OR task."claim_until" <= clock_timestamp()
  );

-- Match queueDurableDeletions, including its live-claim requeue signal.
INSERT INTO "orphan_objects" (
  "bucket", "storage_key", "reason", "target_kind", "state",
  "next_attempt_at", "attempt_count", "created_at"
)
SELECT
  target."bucket", target."storage_key", target."reason",
  target."target_kind", 'PENDING'::"OrphanState",
  clock_timestamp(), 0, clock_timestamp()
FROM "legacy_game_upload_cutover_targets" AS target
ON CONFLICT ("bucket", "storage_key") DO UPDATE
SET "reason" = EXCLUDED."reason";

UPDATE "orphan_objects" AS orphan
SET "target_kind" = CASE WHEN orphan."state" = 'DELETE_CLAIMED'::"OrphanState"
        AND orphan."claim_until" > clock_timestamp()
      THEN orphan."target_kind"
      ELSE target."target_kind"
    END,
    "state" = CASE WHEN orphan."state" = 'DELETE_CLAIMED'::"OrphanState"
        AND orphan."claim_until" > clock_timestamp()
      THEN orphan."state"
      ELSE 'PENDING'::"OrphanState"
    END,
    "claim_token" = CASE WHEN orphan."state" = 'DELETE_CLAIMED'::"OrphanState"
        AND orphan."claim_until" > clock_timestamp()
      THEN orphan."claim_token"
      ELSE NULL
    END,
    "claim_until" = CASE WHEN orphan."state" = 'DELETE_CLAIMED'::"OrphanState"
        AND orphan."claim_until" > clock_timestamp()
      THEN orphan."claim_until"
      ELSE NULL
    END,
    "cancel_reason" = CASE WHEN orphan."state" = 'DELETE_CLAIMED'::"OrphanState"
        AND orphan."claim_until" > clock_timestamp()
      THEN 'business-outbox-requeue-requested'
      ELSE NULL
    END,
    "next_attempt_at" = clock_timestamp(),
    "attempt_count" = CASE WHEN orphan."state" = 'DELETE_CLAIMED'::"OrphanState"
        AND orphan."claim_until" > clock_timestamp()
      THEN orphan."attempt_count"
      ELSE 0
    END,
    "last_tried_at" = CASE WHEN orphan."state" = 'DELETE_CLAIMED'::"OrphanState"
        AND orphan."claim_until" > clock_timestamp()
      THEN orphan."last_tried_at"
      ELSE NULL
    END,
    "last_error" = CASE WHEN orphan."state" = 'DELETE_CLAIMED'::"OrphanState"
        AND orphan."claim_until" > clock_timestamp()
      THEN orphan."last_error"
      ELSE NULL
    END,
    "resolved_at" = CASE WHEN orphan."state" = 'DELETE_CLAIMED'::"OrphanState"
        AND orphan."claim_until" > clock_timestamp()
      THEN orphan."resolved_at"
      ELSE NULL
    END
FROM "legacy_game_upload_cutover_targets" AS target
WHERE orphan."bucket" = target."bucket"
  AND orphan."storage_key" = target."storage_key";

-- Remove every legacy slot, including stale terminal/COMPLETED rows.  Direct
-- sessions keep their generation fencing and active ownership row intact.
DELETE FROM "game_upload_active_sessions" AS active
USING "game_upload_sessions" AS session
WHERE active."session_id" = session."id"
  AND session."transport" = 'API_CHUNK_PROXY'::"GameUploadTransport";

-- Locator erasure happens strictly after both durable outboxes are populated.
UPDATE "game_upload_sessions" AS session
SET "status" = 'FAILED',
    "s3_upload_id" = NULL,
    "s3_key" = NULL,
    "storage_key" = NULL,
    "completion_claim_token" = NULL,
    "completion_claim_until" = NULL,
    "completion_last_error" = 'legacy transport removed by direct-only cutover',
    "completion_result" = NULL,
    "updated_at" = clock_timestamp()
FROM "legacy_game_upload_cutover_candidates" AS candidate
WHERE session."id" = candidate."session_id";

DROP TABLE "game_upload_part_claims";
DROP TABLE "game_upload_parts";

ALTER TABLE "game_upload_sessions"
  DROP CONSTRAINT "game_upload_sessions_transport_state_check";

ALTER TABLE "game_upload_sessions"
  DROP COLUMN "uploaded_chunks",
  DROP COLUMN "staging_path",
  DROP COLUMN "s3_part_etags",
  DROP COLUMN "transport";

DROP TYPE "GameUploadTransport";

COMMIT;
