-- Phase 2 (contract): refuse destructive DDL until every legacy identity has
-- a complete canonical owner, representation, and WebGL generation.
BEGIN;

-- Mutation drain is an operational prerequisite, but the migration also closes
-- the audit-to-DDL race itself. Every contract reader/writer takes these tables
-- in this one documented order and retains the locks through COMMIT.
LOCK TABLE
  "canonical_object_relocations",
  "asset_representations",
  "asset_upload_sessions",
  "assets",
  "exhibitions",
  "game_upload_active_sessions",
  "game_upload_part_claims",
  "game_upload_parts",
  "game_upload_sessions",
  "migration_metrics",
  "multipart_abort_tasks",
  "orphan_objects",
  "project_publication_jobs",
  "project_submission_items",
  "project_submissions",
  "projects",
  "storage_buckets",
  "upload_intents",
  "users",
  "webgl_deployments"
IN ACCESS EXCLUSIVE MODE;

-- Explicit alternate history: the observation age and one pinned image bridge record are waived.
-- Authorization and this receipt are consumed atomically with the contract DDL.
LOCK TABLE "release_contract_authorizations", "release_contract_exception_receipts" IN ACCESS EXCLUSIVE MODE;
DO $exception_authorization$
BEGIN
  IF (SELECT count(*) FROM "release_contract_authorizations"
      WHERE "migration_name" = '20260822000002_canonical_asset_contract_image_bridge36'
        AND "scope" = '24-hour-observation-age-and-image-bridge-36'
        AND "authorized_at" <= clock_timestamp()
        AND "expires_at" > clock_timestamp()
        AND "consumed_at" IS NULL) <> 1 THEN
    RAISE EXCEPTION 'canonical contract age exception lacks a current explicit release authorization';
  END IF;
  IF EXISTS (SELECT 1 FROM "release_contract_exception_receipts") THEN
    RAISE EXCEPTION 'canonical contract age exception receipt already exists';
  END IF;
END
$exception_authorization$;

INSERT INTO "release_contract_exception_receipts"
  ("migration_name", "exception_id", "actor", "run_id", "scope", "source_sha", "image", "migration_checksum",
   "authorized_at", "expires_at", "metrics", "relocation_summary")
SELECT "migration_name", "exception_id", "actor", "run_id", "scope", "source_sha", "image", "migration_checksum",
       "authorized_at", "expires_at",
       (SELECT COALESCE(jsonb_agg(to_jsonb(metric) ORDER BY metric."name"), '[]'::jsonb) FROM "migration_metrics" metric),
       (SELECT jsonb_build_object('total', count(*), 'by_state',
         (SELECT COALESCE(jsonb_object_agg(status_count.state, status_count.total), '{}'::jsonb)
          FROM (SELECT "state"::text AS state, count(*) AS total FROM "canonical_object_relocations" GROUP BY "state") status_count),
         'rows', (SELECT COALESCE(jsonb_agg(to_jsonb(relocation) ORDER BY relocation."id"), '[]'::jsonb) FROM "canonical_object_relocations" relocation))
        FROM "canonical_object_relocations")
FROM "release_contract_authorizations" WHERE "migration_name" = '20260822000002_canonical_asset_contract_image_bridge36';

DO $contract_preflight$
DECLARE
  violations BIGINT;
  has_business_data BOOLEAN;
BEGIN
  SELECT count(*) INTO violations
  FROM "migration_metrics"
  WHERE "value" <> 0 AND NOT COALESCE(("name" = 'public_image_legacy_bridge' AND "scope" = 'api-route'
    AND "value" = 36 AND "last_observed_at" = TIMESTAMP '2026-09-09T10:37:52.913'
    AND "details" -> 'usedLegacyLookup' = 'false'::jsonb), FALSE);
  IF violations <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format('canonical contract blocked: %s non-zero legacy fallback metric rows', violations);
  END IF;

  IF (SELECT count(*) FROM "migration_metrics" WHERE ("name" = 'public_image_legacy_bridge' AND "scope" = 'api-route'
    AND "value" = 36 AND "last_observed_at" = TIMESTAMP '2026-09-09T10:37:52.913'
    AND "details" -> 'usedLegacyLookup' = 'false'::jsonb)) <> 1 THEN
    RAISE EXCEPTION 'canonical contract image-bridge-36 evidence differs from the approved record';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM "users"
    UNION ALL SELECT 1 FROM "exhibitions"
    UNION ALL SELECT 1 FROM "projects"
    UNION ALL SELECT 1 FROM "assets"
  ) INTO has_business_data;

  IF TRUE THEN -- An explicit exception requires all seven observations even on an empty database.
    SELECT count(*) INTO violations
    FROM (
      SELECT known.name
      FROM (VALUES
        ('asset_download_legacy_fallback'),
        ('asset_download_legacy_route'),
        ('public_image_legacy_bridge'),
        ('public_image_legacy_fallback'),
        ('public_webgl_legacy_bridge'),
        ('public_webgl_legacy_fallback'),
        ('export_legacy_fallback')
      ) known(name)
      LEFT JOIN "migration_metrics" metric ON metric."name" = known.name
      GROUP BY known.name
      HAVING count(metric."name") = 0
        OR bool_or(metric."value" <> 0 AND NOT COALESCE((metric."name" = 'public_image_legacy_bridge' AND metric."scope" = 'api-route'
    AND metric."value" = 36 AND metric."last_observed_at" = TIMESTAMP '2026-09-09T10:37:52.913'
    AND metric."details" -> 'usedLegacyLookup' = 'false'::jsonb), FALSE))
        OR bool_or(metric."last_observed_at" IS NULL)
        OR bool_or(NOT isfinite(metric."last_observed_at"))
        OR max(metric."last_observed_at") > CURRENT_TIMESTAMP
    ) unsafe_observation;
    IF violations <> 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = format('canonical contract blocked: %s fallback metrics are missing, non-zero, or lack a 24-hour zero observation', violations);
    END IF;
  END IF;

  SELECT count(*) INTO violations
  FROM "game_upload_sessions"
  WHERE "status" NOT IN ('COMPLETED', 'CANCELLED', 'FAILED', 'RESOLVED');
  IF violations <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format('canonical contract blocked: %s active legacy upload sessions', violations);
  END IF;

  SELECT count(*) INTO violations FROM "game_upload_active_sessions";
  IF violations <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format('canonical contract blocked: %s legacy active upload slots', violations);
  END IF;

  SELECT count(*) INTO violations
  FROM "assets" a
  WHERE ((a."project_id" IS NOT NULL)::integer + (a."exhibition_id" IS NOT NULL)::integer) <> 1;
  IF violations <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format('canonical contract blocked: %s assets do not have exactly one owner', violations);
  END IF;

  SELECT count(*) INTO violations
  FROM "assets"
  WHERE "status"::text IN ('PENDING', 'VERIFYING', 'PROCESSING', 'DELETING');
  IF violations <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format('canonical contract blocked: %s non-terminal assets remain in flight', violations);
  END IF;

  SELECT count(*) INTO violations
  FROM (
    SELECT r."bucket" FROM "asset_representations" r
      LEFT JOIN "storage_buckets" registry ON registry."bucket" = r."bucket"
      WHERE registry."bucket" IS NULL
    UNION ALL
    SELECT r."publication_bucket" FROM "asset_representations" r
      LEFT JOIN "storage_buckets" registry ON registry."bucket" = r."publication_bucket"
      WHERE r."publication_bucket" IS NOT NULL AND registry."bucket" IS NULL
    UNION ALL
    SELECT d."public_bucket" FROM "webgl_deployments" d
      LEFT JOIN "storage_buckets" registry ON registry."bucket" = d."public_bucket"
      WHERE registry."bucket" IS NULL
    UNION ALL
    SELECT d."staging_bucket" FROM "webgl_deployments" d
      LEFT JOIN "storage_buckets" registry ON registry."bucket" = d."staging_bucket"
      WHERE d."staging_bucket" IS NOT NULL AND registry."bucket" IS NULL
  ) unknown_bucket;
  IF violations <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format('canonical contract blocked: %s physical bucket identities are absent from the visibility registry', violations);
  END IF;

  SELECT count(*) INTO violations
  FROM "asset_representations" r
  WHERE btrim(r."bucket") = ''
     OR btrim(r."object_key") = ''
     OR r."size_bytes" < 0
     OR (r."width" IS NOT NULL AND r."width" <= 0)
     OR (r."height" IS NOT NULL AND r."height" <= 0)
     OR (r."state"::text = 'READY' AND btrim(r."mime_type") = '');
  IF violations <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format('canonical contract blocked: %s malformed canonical representations', violations);
  END IF;

  SELECT count(*) INTO violations
  FROM "assets" a
  WHERE a."status"::text = 'READY'
    AND NOT EXISTS (
      SELECT 1
      FROM "asset_representations" r
      WHERE r."asset_id" = a."id"
        AND r."role"::text = CASE WHEN a."kind"::text = 'WEBGL' THEN 'WEBGL_SOURCE' ELSE 'ORIGINAL' END
        AND r."state"::text = 'READY'
    );
  IF violations <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format('canonical contract blocked: %s READY assets lack their canonical source representation', violations);
  END IF;

  SELECT count(*) INTO violations
  FROM "assets" a
  WHERE a."status"::text = 'READY'
    AND a."kind"::text IN ('IMAGE', 'POSTER', 'THUMBNAIL')
    AND (
      NOT EXISTS (
        SELECT 1 FROM "asset_representations" r
        WHERE r."asset_id" = a."id" AND r."role"::text = 'CARD_480' AND r."state"::text = 'READY'
      )
      OR
      NOT EXISTS (
        SELECT 1 FROM "asset_representations" r
        WHERE r."asset_id" = a."id" AND r."role"::text = 'DISPLAY_960' AND r."state"::text = 'READY'
      )
    );
  IF violations <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format('canonical contract blocked: %s READY image assets lack canonical renditions', violations);
  END IF;

  SELECT count(*) INTO violations
  FROM "assets" a
  WHERE a."status"::text = 'READY'
    AND a."kind"::text = 'VIDEO'
    AND a."playback_status"::text = 'READY'
    AND (
      NOT EXISTS (
        SELECT 1 FROM "asset_representations" r
        WHERE r."asset_id" = a."id"
          AND r."role"::text = 'PLAYBACK'
          AND r."state"::text = 'READY'
      )
      OR (a."playback_storage_key" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "asset_representations" r
        WHERE r."asset_id" = a."id"
          AND r."role"::text = 'PLAYBACK'
          AND r."state"::text = 'READY'
          AND r."object_key" = a."playback_storage_key"
      ))
    );
  IF violations <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format('canonical contract blocked: %s video playback identities do not match legacy meaning', violations);
  END IF;

  SELECT count(*) INTO violations
  FROM "exhibitions" e
  LEFT JOIN "assets" a ON a."id" = e."poster_asset_id"
  WHERE (e."poster_storage_key" IS NOT NULL AND e."poster_asset_id" IS NULL)
     OR (e."poster_asset_id" IS NOT NULL AND (
       a."id" IS NULL
       OR a."exhibition_id" IS DISTINCT FROM e."id"
       OR a."project_id" IS NOT NULL
       OR a."kind"::text <> 'POSTER'
       OR a."status"::text <> 'READY'
       OR NOT EXISTS (
         SELECT 1 FROM "asset_representations" r
         WHERE r."asset_id" = a."id" AND r."role"::text = 'ORIGINAL' AND r."state"::text = 'READY'
       )
       OR (e."poster_card_480_height" IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM "asset_representations" r
         WHERE r."asset_id" = a."id" AND r."role"::text = 'CARD_480' AND r."state"::text = 'READY'
       ))
       OR (e."poster_display_960_height" IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM "asset_representations" r
         WHERE r."asset_id" = a."id" AND r."role"::text = 'DISPLAY_960' AND r."state"::text = 'READY'
       ))
       OR EXISTS (
         SELECT 1
         FROM "asset_representations" r
         LEFT JOIN "storage_buckets" registry ON registry."bucket" = r."bucket"
         WHERE r."asset_id" = a."id" AND r."state"::text = 'READY'
           AND r."role"::text IN ('ORIGINAL', 'CARD_480', 'DISPLAY_960')
           AND (registry."visibility"::text IS DISTINCT FROM 'PUBLIC'
             OR r."object_key" NOT LIKE 'public/images/%'
             OR r."publication_bucket" IS NOT NULL
             OR r."publication_object_key" IS NOT NULL)
       )
     ));
  IF violations <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format('canonical contract blocked: %s exhibition poster pointers are unresolved', violations);
  END IF;

  SELECT count(*) INTO violations
  FROM "projects" p
  LEFT JOIN "assets" a ON a."id" = p."poster_asset_id"
  WHERE p."poster_asset_id" IS NOT NULL
    AND (
      a."id" IS NULL
      OR a."project_id" IS DISTINCT FROM p."id"
      OR a."exhibition_id" IS NOT NULL
      OR a."kind"::text NOT IN ('IMAGE', 'POSTER', 'THUMBNAIL')
      OR a."status"::text <> 'READY'
      OR NOT EXISTS (
        SELECT 1 FROM "asset_representations" r
        WHERE r."asset_id" = a."id" AND r."role"::text = 'ORIGINAL' AND r."state"::text = 'READY'
      )
    );
  IF violations <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format('canonical contract blocked: %s project poster pointers are malformed', violations);
  END IF;

  SELECT count(*) INTO violations
  FROM (
    SELECT r."bucket", r."object_key"
    FROM "asset_representations" r
    GROUP BY r."bucket", r."object_key"
    HAVING count(DISTINCT r."asset_id") > 1
  ) duplicate_ownership;
  IF violations <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'unique_violation',
      MESSAGE = format('canonical contract blocked: %s physical objects have multiple asset owners', violations);
  END IF;

  SELECT count(*) INTO violations
  FROM "webgl_deployments" d
  LEFT JOIN "storage_buckets" public_registry ON public_registry."bucket" = d."public_bucket"
  LEFT JOIN "storage_buckets" staging_registry ON staging_registry."bucket" = d."staging_bucket"
  LEFT JOIN "asset_representations" r ON r."id" = d."source_representation_id"
  LEFT JOIN "assets" a ON a."id" = r."asset_id"
  WHERE r."id" IS NULL
     OR r."role"::text <> 'WEBGL_SOURCE'
     OR a."project_id" IS DISTINCT FROM d."project_id"
     OR a."exhibition_id" IS NOT NULL
     OR (d."state"::text = 'READY' AND (
       r."state"::text <> 'READY'
       OR a."kind"::text <> 'WEBGL'
       OR a."status"::text <> 'READY'
     ))
     OR btrim(d."public_bucket") = ''
     OR public_registry."visibility"::text IS DISTINCT FROM 'PUBLIC'
     OR btrim(d."public_prefix") = ''
     OR right(d."public_prefix", 1) <> '/'
     OR left(d."entry_object_key", length(d."public_prefix")) <> d."public_prefix"
     OR (d."state"::text = 'READY' AND (
       (d."staging_bucket" IS NOT NULL AND (
         staging_registry."visibility"::text IS DISTINCT FROM 'PROTECTED'
         OR d."object_manifest" IS NOT NULL
         OR d."staging_object_manifest" IS NULL
         OR jsonb_typeof(d."staging_object_manifest") <> 'object'
         OR d."staging_object_manifest" ->> 'version' <> '1'
         OR jsonb_typeof(d."staging_object_manifest" -> 'objects') <> 'array'
         OR jsonb_array_length(d."staging_object_manifest" -> 'objects') = 0
         OR NOT EXISTS (
           SELECT 1 FROM "projects" p
           JOIN "project_submissions" s ON s."project_id" = p."id"
           WHERE p."id" = d."project_id" AND p."status"::text = 'DRAFT'
             AND s."state"::text IN ('PENDING', 'FINALIZING')
         )
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements(d."staging_object_manifest" -> 'objects') object
           WHERE jsonb_typeof(object) <> 'object'
              OR coalesce(object ->> 'objectKey', '') = ''
              OR left(object ->> 'objectKey', length(d."staging_prefix")) <> d."staging_prefix"
              OR coalesce(object ->> 'sizeBytes', '') !~ '^[0-9]+$'
              OR coalesce(object ->> 'mimeType', '') = ''
              OR jsonb_typeof(object -> 'checksumSha256') <> 'string'
              OR object ->> 'checksumSha256' !~* '^[a-f0-9]{64}$'
         )
         OR NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(d."staging_object_manifest" -> 'objects') object
           WHERE object ->> 'objectKey' = d."staging_entry_object_key"
         )
         OR (SELECT count(*) FROM jsonb_array_elements(d."staging_object_manifest" -> 'objects')) <>
            (SELECT count(DISTINCT object ->> 'objectKey') FROM jsonb_array_elements(d."staging_object_manifest" -> 'objects') object)
       ))
       OR (d."staging_bucket" IS NULL AND (
         d."object_manifest" IS NULL
         OR jsonb_typeof(d."object_manifest") <> 'object'
         OR d."object_manifest" ->> 'version' <> '1'
         OR jsonb_typeof(d."object_manifest" -> 'objects') <> 'array'
         OR jsonb_array_length(d."object_manifest" -> 'objects') = 0
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements(d."object_manifest" -> 'objects') object
           WHERE jsonb_typeof(object) <> 'object'
              OR coalesce(object ->> 'objectKey', '') = ''
              OR left(object ->> 'objectKey', length(d."public_prefix")) <> d."public_prefix"
              OR coalesce(object ->> 'sizeBytes', '') !~ '^[0-9]+$'
              OR coalesce(object ->> 'mimeType', '') = ''
              OR (object ? 'etag' AND jsonb_typeof(object -> 'etag') NOT IN ('string', 'null'))
              OR (object ? 'checksumSha256' AND jsonb_typeof(object -> 'checksumSha256') NOT IN ('string', 'null'))
              OR (jsonb_typeof(object -> 'checksumSha256') = 'string'
                AND object ->> 'checksumSha256' !~* '^[a-f0-9]{64}$')
         )
         OR NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(d."object_manifest" -> 'objects') object
           WHERE object ->> 'objectKey' = d."entry_object_key"
         )
         OR (SELECT count(*) FROM jsonb_array_elements(d."object_manifest" -> 'objects')) <>
            (SELECT count(DISTINCT object ->> 'objectKey') FROM jsonb_array_elements(d."object_manifest" -> 'objects') object)
       ))
     ));
  IF violations <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format('canonical contract blocked: %s malformed WebGL deployments', violations);
  END IF;

  SELECT count(*) INTO violations
  FROM "webgl_deployments" left_deployment
  JOIN "webgl_deployments" right_deployment
    ON left_deployment."id" < right_deployment."id"
   AND left_deployment."public_bucket" = right_deployment."public_bucket"
   AND (
     left(left_deployment."public_prefix", length(right_deployment."public_prefix")) = right_deployment."public_prefix"
     OR left(right_deployment."public_prefix", length(left_deployment."public_prefix")) = left_deployment."public_prefix"
   );
  IF violations <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'unique_violation',
      MESSAGE = format('canonical contract blocked: %s WebGL deployments have overlapping public namespaces', violations);
  END IF;

  SELECT count(*) INTO violations
  FROM "projects" p
  LEFT JOIN "webgl_deployments" d ON d."id" = p."current_webgl_deployment_id"
  WHERE (p."webgl_entry_key" <> '' AND p."current_webgl_deployment_id" IS NULL)
     OR (p."current_webgl_deployment_id" IS NOT NULL AND (
       d."id" IS NULL
       OR p."status"::text NOT IN ('PUBLISHED', 'ARCHIVED')
       OR d."project_id" IS DISTINCT FROM p."id"
       OR d."state"::text <> 'READY'
       OR d."staging_bucket" IS NOT NULL
       OR d."object_manifest" IS NULL
     ));
  IF violations <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format('canonical contract blocked: %s project WebGL pointers are unresolved', violations);
  END IF;

  SELECT count(*) INTO violations
  FROM "project_publication_jobs" job
  LEFT JOIN "project_submissions" submission
    ON submission."id" = job."submission_id" AND submission."project_id" = job."project_id"
  WHERE submission."id" IS NULL
     OR job."plan" ->> 'projectId' IS DISTINCT FROM job."project_id"::text
     OR job."plan" ->> 'submissionId' IS DISTINCT FROM job."submission_id";
  IF violations <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format('canonical contract blocked: %s publication jobs cross project, submission, or plan identity', violations);
  END IF;

  SELECT count(*) INTO violations
  FROM "projects" p
  LEFT JOIN "project_submissions" submission ON submission."project_id" = p."id"
  WHERE (submission."state"::text IN ('PENDING', 'FINALIZING', 'CANCELLED') AND p."status"::text <> 'DRAFT')
     OR (submission."state"::text = 'PUBLISHED' AND p."status"::text NOT IN ('PUBLISHED', 'ARCHIVED'))
     OR (p."status"::text = 'DRAFT' AND p."current_webgl_deployment_id" IS NOT NULL)
    OR (p."status"::text = 'DRAFT' AND EXISTS (
      SELECT 1 FROM "assets" a
      JOIN "asset_representations" r ON r."asset_id" = a."id"
      LEFT JOIN "storage_buckets" source_registry ON source_registry."bucket" = r."bucket"
      LEFT JOIN "storage_buckets" target_registry ON target_registry."bucket" = r."publication_bucket"
      WHERE a."project_id" = p."id" AND a."status"::text = 'READY'
        AND a."kind"::text IN ('IMAGE', 'POSTER', 'THUMBNAIL') AND r."state"::text = 'READY'
        AND (r."publication_bucket" IS NULL OR r."publication_object_key" IS NULL
          OR source_registry."visibility"::text IS DISTINCT FROM 'PROTECTED'
          OR target_registry."visibility"::text IS DISTINCT FROM 'PUBLIC'
          OR r."object_key" NOT LIKE 'protected/publication-staging/projects/' || p."id"::text || '/images/%'
          OR r."object_key" !~ '^protected/publication-staging/projects/[0-9]+/images/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/'
          OR r."publication_object_key" NOT LIKE 'public/images/%'
          OR btrim(COALESCE(r."source_identity_algorithm", '')) = ''
          OR btrim(COALESCE(r."source_identity", '')) = '')
     ))
    OR (p."status"::text = 'DRAFT' AND EXISTS (
      SELECT 1 FROM "webgl_deployments" d
      LEFT JOIN "storage_buckets" public_registry ON public_registry."bucket" = d."public_bucket"
      LEFT JOIN "storage_buckets" staging_registry ON staging_registry."bucket" = d."staging_bucket"
      WHERE d."project_id" = p."id" AND d."state"::text = 'READY'
        AND (d."staging_bucket" IS NULL OR d."staging_object_manifest" IS NULL OR d."object_manifest" IS NOT NULL
          OR staging_registry."visibility"::text IS DISTINCT FROM 'PROTECTED'
          OR public_registry."visibility"::text IS DISTINCT FROM 'PUBLIC')
     ))
    OR (p."status"::text IN ('PUBLISHED', 'ARCHIVED') AND EXISTS (
      SELECT 1 FROM "assets" a
      JOIN "asset_representations" r ON r."asset_id" = a."id"
      LEFT JOIN "storage_buckets" source_registry ON source_registry."bucket" = r."bucket"
      WHERE a."project_id" = p."id" AND a."status"::text = 'READY'
        AND a."kind"::text IN ('IMAGE', 'POSTER', 'THUMBNAIL') AND r."state"::text = 'READY'
        AND (r."publication_bucket" IS NOT NULL OR r."publication_object_key" IS NOT NULL
          OR source_registry."visibility"::text IS DISTINCT FROM 'PUBLIC'
          OR r."object_key" NOT LIKE 'public/images/%')
     ))
    OR (p."status"::text IN ('PUBLISHED', 'ARCHIVED') AND EXISTS (
      SELECT 1 FROM "webgl_deployments" d
      LEFT JOIN "storage_buckets" public_registry ON public_registry."bucket" = d."public_bucket"
      WHERE d."project_id" = p."id" AND d."state"::text = 'READY'
        AND (d."staging_bucket" IS NOT NULL OR d."staging_object_manifest" IS NOT NULL OR d."object_manifest" IS NULL
          OR public_registry."visibility"::text IS DISTINCT FROM 'PUBLIC')
     ));
  IF violations <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format('canonical contract blocked: %s projects violate publication-state object ownership', violations);
  END IF;

  SELECT count(*) INTO violations
  FROM "canonical_object_relocations"
  WHERE "state" <> 'COMMITTED'
     OR "checksum_sha256" IS NULL
     OR "materialized_at" IS NULL
     OR "committed_at" IS NULL;
  IF violations <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format('canonical contract blocked: %s object relocations are not durably committed', violations);
  END IF;

  SELECT count(*) INTO violations
  FROM "canonical_object_relocations" relocation
  WHERE NOT EXISTS (
    SELECT 1
    FROM "asset_representations" representation
    JOIN "assets" asset ON asset."id" = representation."asset_id"
    LEFT JOIN "exhibitions" exhibition ON exhibition."poster_asset_id" = asset."id"
    WHERE representation."state"::text = 'READY'
      AND representation."bucket" = relocation."destination_bucket"
      AND representation."object_key" = relocation."destination_object_key"
      AND representation."size_bytes" = relocation."size_bytes"
      AND lower(representation."mime_type") = lower(relocation."mime_type")
      AND representation."checksum_algorithm" = 'SHA256'
      AND lower(representation."checksum") = relocation."checksum_sha256"
      AND representation."role"::text = relocation."role"
      AND (
        (relocation."work_kind" = 'asset' AND relocation."work_ref" = asset."id"::text)
        OR (relocation."work_kind" = 'exhibition' AND relocation."work_ref" = exhibition."id"::text)
      )
  );
  IF violations <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format('canonical contract blocked: %s committed relocations do not match a READY canonical destination', violations);
  END IF;
END
$contract_preflight$;

DO $relocation_source_cleanup$
DECLARE
  violations BIGINT;
BEGIN
  SELECT count(*) INTO violations
  FROM (
    SELECT DISTINCT relocation."source_bucket", relocation."source_object_key"
    FROM "canonical_object_relocations" relocation
  ) source
  WHERE EXISTS (
      SELECT 1 FROM "asset_representations" representation
      WHERE representation."bucket" = source."source_bucket"
        AND representation."object_key" = source."source_object_key"
        AND representation."state"::text <> 'DELETED'
    )
    OR EXISTS (
      SELECT 1 FROM "asset_upload_sessions" session
      WHERE session."bucket" = source."source_bucket"
        AND session."object_key" = source."source_object_key"
        AND session."state"::text IN ('ALLOCATING', 'UPLOADING', 'COMPLETING', 'VERIFYING')
    )
    OR EXISTS (
      SELECT 1 FROM "upload_intents" intent
      WHERE intent."bucket" = source."source_bucket"
        AND intent."storage_key" = source."source_object_key"
        AND intent."state"::text IN ('PREPARED', 'UPLOADED')
    )
    OR EXISTS (
      SELECT 1
      FROM "webgl_deployments" deployment
      CROSS JOIN LATERAL jsonb_array_elements(
        COALESCE(deployment."object_manifest" -> 'objects', '[]'::jsonb)
      ) object
      WHERE deployment."state"::text = 'READY'
        AND deployment."public_bucket" = source."source_bucket"
        AND object ->> 'objectKey' = source."source_object_key"
    )
    OR EXISTS (
      SELECT 1
      FROM "webgl_deployments" deployment
      CROSS JOIN LATERAL jsonb_array_elements(
        COALESCE(deployment."staging_object_manifest" -> 'objects', '[]'::jsonb)
      ) object
      WHERE deployment."state"::text = 'READY'
        AND deployment."staging_bucket" = source."source_bucket"
        AND object ->> 'objectKey' = source."source_object_key"
    );
  IF violations <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format('canonical contract blocked: %s relocation sources still have live canonical or upload references', violations);
  END IF;

  INSERT INTO "orphan_objects" (
    "bucket", "storage_key", "reason", "target_kind", "state",
    "claim_token", "claim_until", "cancel_reason", "next_attempt_at",
    "attempt_count", "last_tried_at", "last_error", "resolved_at"
  )
  SELECT DISTINCT relocation."source_bucket", relocation."source_object_key",
    'canonical-contract-relocation-source', 'EXACT'::"OrphanTargetKind", 'PENDING'::"OrphanState",
    NULL::TEXT, NULL::TIMESTAMP(3), NULL::TEXT, clock_timestamp(), 0,
    NULL::TIMESTAMP(3), NULL::TEXT, NULL::TIMESTAMP(3)
  FROM "canonical_object_relocations" relocation
  ON CONFLICT ("bucket", "storage_key") DO UPDATE SET
    "reason" = EXCLUDED."reason", "target_kind" = EXCLUDED."target_kind",
    "state" = EXCLUDED."state", "claim_token" = NULL, "claim_until" = NULL,
    "cancel_reason" = NULL, "next_attempt_at" = EXCLUDED."next_attempt_at",
    "attempt_count" = 0, "last_tried_at" = NULL, "last_error" = NULL, "resolved_at" = NULL
  WHERE "orphan_objects"."state" <> 'DELETE_CLAIMED'::"OrphanState"
     OR "orphan_objects"."claim_until" IS NULL
     OR "orphan_objects"."claim_until" <= clock_timestamp();
END
$relocation_source_cleanup$;

ALTER TABLE "assets"
  ADD CONSTRAINT "assets_owner_xor_check"
  CHECK ((("project_id" IS NOT NULL)::integer + ("exhibition_id" IS NOT NULL)::integer) = 1);

ALTER TABLE "asset_representations"
  ADD CONSTRAINT "asset_representations_identity_check"
  CHECK (btrim("bucket") <> '' AND btrim("object_key") <> ''),
  ADD CONSTRAINT "asset_representations_size_check"
  CHECK ("size_bytes" >= 0),
  ADD CONSTRAINT "asset_representations_dimensions_check"
  CHECK (("width" IS NULL OR "width" > 0) AND ("height" IS NULL OR "height" > 0)),
  ADD CONSTRAINT "asset_representations_ready_mime_check"
  CHECK ("state"::text <> 'READY' OR btrim("mime_type") <> '');

ALTER TABLE "asset_representations"
  ADD CONSTRAINT "asset_representations_bucket_fkey"
    FOREIGN KEY ("bucket") REFERENCES "storage_buckets"("bucket") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_representations_publication_bucket_fkey"
    FOREIGN KEY ("publication_bucket") REFERENCES "storage_buckets"("bucket") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "webgl_deployments"
  ADD CONSTRAINT "webgl_deployments_public_identity_check"
  CHECK (
    btrim("public_bucket") <> ''
    AND btrim("public_prefix") <> ''
    AND right("public_prefix", 1) = '/'
    AND left("entry_object_key", length("public_prefix")) = "public_prefix"
  ),
  ADD CONSTRAINT "webgl_deployments_ready_manifest_check"
  CHECK (
    "state"::text <> 'READY'
    OR ("staging_bucket" IS NOT NULL AND "staging_object_manifest" IS NOT NULL AND "object_manifest" IS NULL)
    OR ("staging_bucket" IS NULL AND "object_manifest" IS NOT NULL)
  );

ALTER TABLE "webgl_deployments"
  ADD CONSTRAINT "webgl_deployments_public_bucket_fkey"
    FOREIGN KEY ("public_bucket") REFERENCES "storage_buckets"("bucket") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "webgl_deployments_staging_bucket_fkey"
    FOREIGN KEY ("staging_bucket") REFERENCES "storage_buckets"("bucket") ON DELETE RESTRICT ON UPDATE CASCADE;

DROP INDEX "webgl_deployments_public_bucket_prefix_idx";
CREATE UNIQUE INDEX "webgl_deployments_public_bucket_prefix_key"
  ON "webgl_deployments"("public_bucket", "public_prefix");

CREATE FUNCTION "canonical_webgl_public_namespace_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."public_bucket", 0));
  IF EXISTS (
    SELECT 1 FROM "webgl_deployments" existing
    WHERE existing."public_bucket" = NEW."public_bucket"
      AND existing."id" <> NEW."id"
      AND (
        left(existing."public_prefix", length(NEW."public_prefix")) = NEW."public_prefix"
        OR left(NEW."public_prefix", length(existing."public_prefix")) = existing."public_prefix"
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'unique_violation',
      MESSAGE = 'WebGL public deployment namespaces cannot overlap';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "webgl_deployments_public_namespace_guard"
BEFORE INSERT OR UPDATE OF "public_bucket", "public_prefix" ON "webgl_deployments"
FOR EACH ROW EXECUTE FUNCTION "canonical_webgl_public_namespace_guard"();

CREATE FUNCTION "canonical_assert_asset_ready"(checked_asset_id INTEGER)
RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
  checked_asset "assets"%ROWTYPE;
BEGIN
  SELECT * INTO checked_asset FROM "assets" WHERE "id" = checked_asset_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF ((checked_asset."project_id" IS NOT NULL)::integer
      + (checked_asset."exhibition_id" IS NOT NULL)::integer) <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'asset must have exactly one canonical owner';
  END IF;

  IF checked_asset."status"::text = 'READY' AND NOT EXISTS (
    SELECT 1 FROM "asset_representations" r
    WHERE r."asset_id" = checked_asset."id"
      AND r."role"::text = CASE WHEN checked_asset."kind"::text = 'WEBGL' THEN 'WEBGL_SOURCE' ELSE 'ORIGINAL' END
      AND r."state"::text = 'READY'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'READY asset lacks its canonical source representation';
  END IF;

  IF checked_asset."status"::text = 'READY'
     AND checked_asset."kind"::text IN ('IMAGE', 'POSTER', 'THUMBNAIL')
     AND (
       NOT EXISTS (
         SELECT 1 FROM "asset_representations" r
         WHERE r."asset_id" = checked_asset."id" AND r."role"::text = 'CARD_480' AND r."state"::text = 'READY'
       )
       OR NOT EXISTS (
         SELECT 1 FROM "asset_representations" r
         WHERE r."asset_id" = checked_asset."id" AND r."role"::text = 'DISPLAY_960' AND r."state"::text = 'READY'
       )
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'READY image asset lacks canonical responsive representations';
  END IF;
END
$function$;

CREATE FUNCTION "canonical_asset_guard_trigger"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM "canonical_assert_asset_ready"(NEW."id");
  RETURN NEW;
END
$function$;

CREATE CONSTRAINT TRIGGER "assets_canonical_ready_guard"
AFTER INSERT OR UPDATE ON "assets"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "canonical_asset_guard_trigger"();

CREATE FUNCTION "canonical_representation_guard_trigger"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM "canonical_assert_asset_ready"(OLD."asset_id");
    RETURN OLD;
  ELSIF TG_OP = 'INSERT' THEN
    PERFORM "canonical_assert_asset_ready"(NEW."asset_id");
    RETURN NEW;
  END IF;
  PERFORM "canonical_assert_asset_ready"(OLD."asset_id");
  IF NEW."asset_id" IS DISTINCT FROM OLD."asset_id" THEN
    PERFORM "canonical_assert_asset_ready"(NEW."asset_id");
  END IF;
  RETURN NEW;
END
$function$;

CREATE CONSTRAINT TRIGGER "asset_representations_asset_ready_guard"
AFTER INSERT OR UPDATE OR DELETE ON "asset_representations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "canonical_representation_guard_trigger"();

CREATE FUNCTION "canonical_representation_object_owner_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(length(NEW."bucket")::text || ':' || NEW."bucket" || NEW."object_key", 0));
  IF EXISTS (
    SELECT 1 FROM "asset_representations" existing
    WHERE existing."bucket" = NEW."bucket"
      AND existing."object_key" = NEW."object_key"
      AND existing."asset_id" <> NEW."asset_id"
      AND existing."id" <> NEW."id"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'unique_violation',
      MESSAGE = 'physical object cannot be owned by more than one asset';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "asset_representations_distinct_owner_guard"
BEFORE INSERT OR UPDATE OF "asset_id", "bucket", "object_key" ON "asset_representations"
FOR EACH ROW EXECUTE FUNCTION "canonical_representation_object_owner_guard"();

CREATE FUNCTION "canonical_assert_webgl_deployment"(checked_deployment_id TEXT)
RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
  deployment "webgl_deployments"%ROWTYPE;
  source_role TEXT;
  source_state TEXT;
  source_project_id INTEGER;
  source_exhibition_id INTEGER;
  source_asset_kind TEXT;
  source_asset_state TEXT;
  public_visibility TEXT;
  staging_visibility TEXT;
BEGIN
  SELECT * INTO deployment FROM "webgl_deployments" WHERE "id" = checked_deployment_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT r."role"::text, r."state"::text, a."project_id", a."exhibition_id", a."kind"::text, a."status"::text
  INTO source_role, source_state, source_project_id, source_exhibition_id, source_asset_kind, source_asset_state
  FROM "asset_representations" r
  JOIN "assets" a ON a."id" = r."asset_id"
  WHERE r."id" = deployment."source_representation_id";

  IF NOT FOUND OR source_role <> 'WEBGL_SOURCE'
     OR source_project_id IS DISTINCT FROM deployment."project_id"
     OR source_exhibition_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'WebGL deployment source must be a WEBGL_SOURCE owned by the same project';
  END IF;

  IF deployment."state"::text = 'READY'
     AND (source_state <> 'READY' OR source_asset_kind <> 'WEBGL' OR source_asset_state <> 'READY') THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'READY WebGL deployment requires a READY WEBGL asset and READY WEBGL_SOURCE';
  END IF;

  SELECT registry."visibility"::text INTO public_visibility
  FROM "storage_buckets" registry WHERE registry."bucket" = deployment."public_bucket";
  IF public_visibility IS DISTINCT FROM 'PUBLIC' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'WebGL public bucket must be registered PUBLIC';
  END IF;

  IF deployment."staging_bucket" IS NOT NULL THEN
    SELECT registry."visibility"::text INTO staging_visibility
    FROM "storage_buckets" registry WHERE registry."bucket" = deployment."staging_bucket";
    IF staging_visibility IS DISTINCT FROM 'PROTECTED' THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'WebGL staging bucket must be registered PROTECTED';
    END IF;
  END IF;

  IF deployment."state"::text = 'READY' AND deployment."staging_bucket" IS NOT NULL AND (
    deployment."object_manifest" IS NOT NULL
    OR deployment."staging_object_manifest" IS NULL
    OR jsonb_typeof(deployment."staging_object_manifest") <> 'object'
    OR deployment."staging_object_manifest" ->> 'version' <> '1'
    OR jsonb_typeof(deployment."staging_object_manifest" -> 'objects') <> 'array'
    OR jsonb_array_length(deployment."staging_object_manifest" -> 'objects') = 0
    OR NOT EXISTS (
      SELECT 1 FROM "projects" p
      JOIN "project_submissions" s ON s."project_id" = p."id"
      WHERE p."id" = deployment."project_id" AND p."status"::text = 'DRAFT'
        AND s."state"::text IN ('PENDING', 'FINALIZING')
    )
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(deployment."staging_object_manifest" -> 'objects') object
      WHERE jsonb_typeof(object) <> 'object'
         OR coalesce(object ->> 'objectKey', '') = ''
         OR left(object ->> 'objectKey', length(deployment."staging_prefix")) <> deployment."staging_prefix"
         OR coalesce(object ->> 'sizeBytes', '') !~ '^[0-9]+$'
         OR coalesce(object ->> 'mimeType', '') = ''
         OR jsonb_typeof(object -> 'checksumSha256') <> 'string'
         OR object ->> 'checksumSha256' !~* '^[a-f0-9]{64}$'
    )
    OR NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(deployment."staging_object_manifest" -> 'objects') object
      WHERE object ->> 'objectKey' = deployment."staging_entry_object_key"
    )
    OR (SELECT count(*) FROM jsonb_array_elements(deployment."staging_object_manifest" -> 'objects')) <>
       (SELECT count(DISTINCT object ->> 'objectKey') FROM jsonb_array_elements(deployment."staging_object_manifest" -> 'objects') object)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'READY staged WebGL deployment requires a complete checksummed staging manifest';
  ELSIF deployment."state"::text = 'READY' AND deployment."staging_bucket" IS NULL AND (
    deployment."object_manifest" IS NULL
    OR jsonb_typeof(deployment."object_manifest") <> 'object'
    OR deployment."object_manifest" ->> 'version' <> '1'
    OR jsonb_typeof(deployment."object_manifest" -> 'objects') <> 'array'
    OR jsonb_array_length(deployment."object_manifest" -> 'objects') = 0
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(deployment."object_manifest" -> 'objects') object
      WHERE jsonb_typeof(object) <> 'object'
         OR coalesce(object ->> 'objectKey', '') = ''
         OR left(object ->> 'objectKey', length(deployment."public_prefix")) <> deployment."public_prefix"
         OR coalesce(object ->> 'sizeBytes', '') !~ '^[0-9]+$'
         OR coalesce(object ->> 'mimeType', '') = ''
         OR (object ? 'etag' AND jsonb_typeof(object -> 'etag') NOT IN ('string', 'null'))
         OR (object ? 'checksumSha256' AND jsonb_typeof(object -> 'checksumSha256') NOT IN ('string', 'null'))
         OR (jsonb_typeof(object -> 'checksumSha256') = 'string'
           AND object ->> 'checksumSha256' !~* '^[a-f0-9]{64}$')
    )
    OR NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(deployment."object_manifest" -> 'objects') object
      WHERE object ->> 'objectKey' = deployment."entry_object_key"
    )
    OR (SELECT count(*) FROM jsonb_array_elements(deployment."object_manifest" -> 'objects')) <>
       (SELECT count(DISTINCT object ->> 'objectKey') FROM jsonb_array_elements(deployment."object_manifest" -> 'objects') object)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'READY public WebGL deployment requires a complete immutable object manifest';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "projects" p
    WHERE p."current_webgl_deployment_id" = deployment."id"
      AND (p."id" <> deployment."project_id" OR deployment."state"::text <> 'READY'
		OR p."status"::text NOT IN ('PUBLISHED', 'ARCHIVED')
        OR deployment."staging_bucket" IS NOT NULL OR deployment."object_manifest" IS NULL)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'current WebGL deployment must belong to that project and remain READY';
  END IF;
END
$function$;

CREATE FUNCTION "canonical_webgl_deployment_guard_trigger"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM "canonical_assert_webgl_deployment"(NEW."id");
  RETURN NEW;
END
$function$;

CREATE CONSTRAINT TRIGGER "webgl_deployments_canonical_guard"
AFTER INSERT OR UPDATE ON "webgl_deployments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "canonical_webgl_deployment_guard_trigger"();

CREATE FUNCTION "canonical_webgl_source_guard_trigger"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  deployment_id TEXT;
BEGIN
  FOR deployment_id IN
    SELECT d."id" FROM "webgl_deployments" d
    WHERE d."source_representation_id" IN (OLD."id", NEW."id")
  LOOP
    PERFORM "canonical_assert_webgl_deployment"(deployment_id);
  END LOOP;
  RETURN COALESCE(NEW, OLD);
END
$function$;

CREATE CONSTRAINT TRIGGER "asset_representations_webgl_source_guard"
AFTER UPDATE OF "asset_id", "role", "state" ON "asset_representations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "canonical_webgl_source_guard_trigger"();

CREATE FUNCTION "canonical_asset_webgl_owner_guard_trigger"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  deployment_id TEXT;
BEGIN
  FOR deployment_id IN
    SELECT d."id"
    FROM "webgl_deployments" d
    JOIN "asset_representations" r ON r."id" = d."source_representation_id"
    WHERE r."asset_id" = NEW."id"
  LOOP
    PERFORM "canonical_assert_webgl_deployment"(deployment_id);
  END LOOP;
  RETURN NEW;
END
$function$;

CREATE CONSTRAINT TRIGGER "assets_webgl_source_owner_guard"
AFTER UPDATE OF "project_id", "exhibition_id" ON "assets"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "canonical_asset_webgl_owner_guard_trigger"();

CREATE FUNCTION "canonical_project_pointer_guard_trigger"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  deployment_project_id INTEGER;
  deployment_state TEXT;
  deployment_staging_bucket TEXT;
  deployment_object_manifest JSONB;
  poster_project_id INTEGER;
  poster_exhibition_id INTEGER;
  poster_kind TEXT;
  poster_status TEXT;
BEGIN
  IF NEW."current_webgl_deployment_id" IS NOT NULL THEN
    SELECT d."project_id", d."state"::text, d."staging_bucket", d."object_manifest"
    INTO deployment_project_id, deployment_state, deployment_staging_bucket, deployment_object_manifest
    FROM "webgl_deployments" d
    WHERE d."id" = NEW."current_webgl_deployment_id";
    IF NOT FOUND OR deployment_project_id IS DISTINCT FROM NEW."id" OR deployment_state <> 'READY'
       OR deployment_staging_bucket IS NOT NULL OR deployment_object_manifest IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'project current WebGL pointer must reference its own READY deployment';
    END IF;
  END IF;

  IF NEW."poster_asset_id" IS NOT NULL THEN
    SELECT a."project_id", a."exhibition_id", a."kind"::text, a."status"::text
    INTO poster_project_id, poster_exhibition_id, poster_kind, poster_status
    FROM "assets" a WHERE a."id" = NEW."poster_asset_id";
    IF NOT FOUND OR poster_project_id IS DISTINCT FROM NEW."id" OR poster_exhibition_id IS NOT NULL
       OR poster_kind NOT IN ('IMAGE', 'POSTER', 'THUMBNAIL') OR poster_status <> 'READY'
       OR NOT EXISTS (
         SELECT 1 FROM "asset_representations" r
         WHERE r."asset_id" = NEW."poster_asset_id" AND r."role"::text = 'ORIGINAL' AND r."state"::text = 'READY'
       ) THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'project poster pointer must reference its own READY image asset';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE CONSTRAINT TRIGGER "projects_canonical_pointer_guard"
AFTER INSERT OR UPDATE OF "poster_asset_id", "current_webgl_deployment_id" ON "projects"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "canonical_project_pointer_guard_trigger"();

CREATE FUNCTION "canonical_exhibition_pointer_guard_trigger"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  poster_project_id INTEGER;
  poster_exhibition_id INTEGER;
  poster_kind TEXT;
  poster_status TEXT;
BEGIN
  IF NEW."poster_asset_id" IS NOT NULL THEN
    SELECT a."project_id", a."exhibition_id", a."kind"::text, a."status"::text
    INTO poster_project_id, poster_exhibition_id, poster_kind, poster_status
    FROM "assets" a WHERE a."id" = NEW."poster_asset_id";
    IF NOT FOUND OR poster_project_id IS NOT NULL OR poster_exhibition_id IS DISTINCT FROM NEW."id"
       OR poster_kind <> 'POSTER' OR poster_status <> 'READY'
       OR NOT EXISTS (
         SELECT 1 FROM "asset_representations" r
         WHERE r."asset_id" = NEW."poster_asset_id" AND r."role"::text = 'ORIGINAL' AND r."state"::text = 'READY'
       ) THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'exhibition poster pointer must reference its own READY POSTER asset';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE CONSTRAINT TRIGGER "exhibitions_canonical_pointer_guard"
AFTER INSERT OR UPDATE OF "poster_asset_id" ON "exhibitions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "canonical_exhibition_pointer_guard_trigger"();

-- Pointer setters and target-row mutations share transaction-scoped fences.
-- Project, asset, and deployment fences are always acquired in that order,
-- and pairs inside one class are ordered, so reverse target mutations cannot
-- deadlock a pointer or publication-state transition.
CREATE FUNCTION "canonical_lock_project_ids"(left_project_id INTEGER, right_project_id INTEGER DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
AS $function$
BEGIN
  IF left_project_id IS NULL AND right_project_id IS NULL THEN RETURN; END IF;
  IF left_project_id IS NULL THEN
    PERFORM pg_advisory_xact_lock(17290, right_project_id);
  ELSIF right_project_id IS NULL OR left_project_id = right_project_id THEN
    PERFORM pg_advisory_xact_lock(17290, left_project_id);
  ELSIF left_project_id < right_project_id THEN
    PERFORM pg_advisory_xact_lock(17290, left_project_id);
    PERFORM pg_advisory_xact_lock(17290, right_project_id);
  ELSE
    PERFORM pg_advisory_xact_lock(17290, right_project_id);
    PERFORM pg_advisory_xact_lock(17290, left_project_id);
  END IF;
END
$function$;

CREATE FUNCTION "canonical_lock_asset_ids"(left_asset_id INTEGER, right_asset_id INTEGER DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
AS $function$
BEGIN
  IF left_asset_id IS NULL AND right_asset_id IS NULL THEN RETURN; END IF;
  IF left_asset_id IS NULL THEN
    PERFORM pg_advisory_xact_lock(17291, right_asset_id);
  ELSIF right_asset_id IS NULL OR left_asset_id = right_asset_id THEN
    PERFORM pg_advisory_xact_lock(17291, left_asset_id);
  ELSIF left_asset_id < right_asset_id THEN
    PERFORM pg_advisory_xact_lock(17291, left_asset_id);
    PERFORM pg_advisory_xact_lock(17291, right_asset_id);
  ELSE
    PERFORM pg_advisory_xact_lock(17291, right_asset_id);
    PERFORM pg_advisory_xact_lock(17291, left_asset_id);
  END IF;
END
$function$;

CREATE FUNCTION "canonical_assert_project_publication"(checked_project_id INTEGER)
RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
  project_status TEXT;
  current_deployment_id TEXT;
  submission_state TEXT;
BEGIN
  SELECT p."status"::text, p."current_webgl_deployment_id"
  INTO project_status, current_deployment_id
  FROM "projects" p WHERE p."id" = checked_project_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT s."state"::text INTO submission_state
  FROM "project_submissions" s WHERE s."project_id" = checked_project_id;

  IF submission_state IN ('PENDING', 'FINALIZING', 'CANCELLED') AND project_status <> 'DRAFT' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'active or cancelled submission must remain attached to a DRAFT project';
  END IF;
  IF submission_state = 'PUBLISHED' AND project_status NOT IN ('PUBLISHED', 'ARCHIVED') THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'published submission cannot return to a DRAFT project';
  END IF;

  IF project_status = 'DRAFT' THEN
    IF current_deployment_id IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'DRAFT project cannot have a current WebGL deployment';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "assets" a
      JOIN "asset_representations" r ON r."asset_id" = a."id"
      LEFT JOIN "storage_buckets" source_registry ON source_registry."bucket" = r."bucket"
      LEFT JOIN "storage_buckets" target_registry ON target_registry."bucket" = r."publication_bucket"
      WHERE a."project_id" = checked_project_id AND a."status"::text = 'READY'
        AND a."kind"::text IN ('IMAGE', 'POSTER', 'THUMBNAIL') AND r."state"::text = 'READY'
        AND (r."publication_bucket" IS NULL OR r."publication_object_key" IS NULL
          OR source_registry."visibility"::text IS DISTINCT FROM 'PROTECTED'
          OR target_registry."visibility"::text IS DISTINCT FROM 'PUBLIC'
          OR r."object_key" NOT LIKE 'protected/publication-staging/projects/' || checked_project_id::text || '/images/%'
          OR r."object_key" !~ '^protected/publication-staging/projects/[0-9]+/images/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/'
          OR r."publication_object_key" NOT LIKE 'public/images/%'
          OR btrim(COALESCE(r."source_identity_algorithm", '')) = ''
          OR btrim(COALESCE(r."source_identity", '')) = '')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'DRAFT project image representations must remain in UUID-scoped protected publication staging';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "webgl_deployments" d
      LEFT JOIN "storage_buckets" public_registry ON public_registry."bucket" = d."public_bucket"
      LEFT JOIN "storage_buckets" staging_registry ON staging_registry."bucket" = d."staging_bucket"
      WHERE d."project_id" = checked_project_id AND d."state"::text = 'READY'
        AND (d."staging_bucket" IS NULL OR d."staging_object_manifest" IS NULL OR d."object_manifest" IS NOT NULL
          OR staging_registry."visibility"::text IS DISTINCT FROM 'PROTECTED'
          OR public_registry."visibility"::text IS DISTINCT FROM 'PUBLIC')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'DRAFT project WebGL deployments must remain protected and unpublished';
    END IF;
  ELSIF project_status IN ('PUBLISHED', 'ARCHIVED') THEN
    IF EXISTS (
      SELECT 1 FROM "assets" a
      JOIN "asset_representations" r ON r."asset_id" = a."id"
      LEFT JOIN "storage_buckets" source_registry ON source_registry."bucket" = r."bucket"
      WHERE a."project_id" = checked_project_id AND a."status"::text = 'READY'
        AND a."kind"::text IN ('IMAGE', 'POSTER', 'THUMBNAIL') AND r."state"::text = 'READY'
        AND (r."publication_bucket" IS NOT NULL OR r."publication_object_key" IS NOT NULL
          OR source_registry."visibility"::text IS DISTINCT FROM 'PUBLIC'
          OR r."object_key" NOT LIKE 'public/images/%')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'PUBLISHED project image representations cannot return to protected staging';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "webgl_deployments" d
      LEFT JOIN "storage_buckets" public_registry ON public_registry."bucket" = d."public_bucket"
      WHERE d."project_id" = checked_project_id AND d."state"::text = 'READY'
        AND (d."staging_bucket" IS NOT NULL OR d."staging_object_manifest" IS NOT NULL OR d."object_manifest" IS NULL
          OR public_registry."visibility"::text IS DISTINCT FROM 'PUBLIC')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'PUBLISHED project WebGL deployments cannot return to protected staging';
    END IF;
  END IF;
END
$function$;

CREATE FUNCTION "canonical_storage_bucket_publication_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  checked_project_id INTEGER;
BEGIN
  FOR checked_project_id IN
    SELECT DISTINCT dependency."project_id"
    FROM (
      SELECT a."project_id"
      FROM "asset_representations" r
      JOIN "assets" a ON a."id" = r."asset_id"
      WHERE r."bucket" IN (OLD."bucket", NEW."bucket")
         OR r."publication_bucket" IN (OLD."bucket", NEW."bucket")
      UNION
      SELECT d."project_id"
      FROM "webgl_deployments" d
      WHERE d."public_bucket" IN (OLD."bucket", NEW."bucket")
         OR d."staging_bucket" IN (OLD."bucket", NEW."bucket")
    ) dependency
    WHERE dependency."project_id" IS NOT NULL
    ORDER BY dependency."project_id"
  LOOP
    PERFORM "canonical_lock_project_ids"(checked_project_id);
    PERFORM "canonical_assert_project_publication"(checked_project_id);
  END LOOP;
  RETURN NEW;
END
$function$;

CREATE CONSTRAINT TRIGGER "storage_buckets_publication_guard"
AFTER UPDATE OF "bucket", "visibility" ON "storage_buckets"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "canonical_storage_bucket_publication_guard"();

CREATE FUNCTION "canonical_project_status_transition_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM "canonical_lock_project_ids"(OLD."id", NEW."id");
  IF OLD."status"::text IN ('PUBLISHED', 'ARCHIVED') AND NEW."status"::text = 'DRAFT' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'published project cannot return to DRAFT';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "projects_publication_state_transition"
BEFORE UPDATE OF "status" ON "projects"
FOR EACH ROW EXECUTE FUNCTION "canonical_project_status_transition_guard"();

CREATE FUNCTION "canonical_submission_state_transition_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM "canonical_lock_project_ids"(OLD."project_id", NEW."project_id");
  IF OLD."state"::text = 'PUBLISHED' AND NEW."state"::text <> 'PUBLISHED' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'published submission cannot return to a mutable state';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "project_submissions_publication_state_transition"
BEFORE UPDATE OF "state", "project_id" ON "project_submissions"
FOR EACH ROW EXECUTE FUNCTION "canonical_submission_state_transition_guard"();

CREATE FUNCTION "canonical_lock_deployment"(deployment_id TEXT)
RETURNS void
LANGUAGE plpgsql
AS $function$
BEGIN
  IF deployment_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('canonical-deployment:' || deployment_id, 0));
  END IF;
END
$function$;

CREATE FUNCTION "canonical_lock_deployment_ids"(left_deployment_id TEXT, right_deployment_id TEXT DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
AS $function$
BEGIN
  IF left_deployment_id IS NULL THEN
    PERFORM "canonical_lock_deployment"(right_deployment_id);
  ELSIF right_deployment_id IS NULL OR left_deployment_id = right_deployment_id THEN
    PERFORM "canonical_lock_deployment"(left_deployment_id);
  ELSIF left_deployment_id < right_deployment_id THEN
    PERFORM "canonical_lock_deployment"(left_deployment_id);
    PERFORM "canonical_lock_deployment"(right_deployment_id);
  ELSE
    PERFORM "canonical_lock_deployment"(right_deployment_id);
    PERFORM "canonical_lock_deployment"(left_deployment_id);
  END IF;
END
$function$;

CREATE FUNCTION "canonical_assert_project_pointers"(checked_project_id INTEGER)
RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
  checked_project "projects"%ROWTYPE;
  poster_project_id INTEGER;
  poster_exhibition_id INTEGER;
  poster_kind TEXT;
  poster_status TEXT;
  deployment_project_id INTEGER;
  deployment_state TEXT;
  deployment_staging_bucket TEXT;
  deployment_object_manifest JSONB;
BEGIN
  SELECT * INTO checked_project FROM "projects" WHERE "id" = checked_project_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF checked_project."poster_asset_id" IS NOT NULL THEN
    SELECT a."project_id", a."exhibition_id", a."kind"::text, a."status"::text
    INTO poster_project_id, poster_exhibition_id, poster_kind, poster_status
    FROM "assets" a WHERE a."id" = checked_project."poster_asset_id";
    IF NOT FOUND OR poster_project_id IS DISTINCT FROM checked_project."id" OR poster_exhibition_id IS NOT NULL
       OR poster_kind NOT IN ('IMAGE', 'POSTER', 'THUMBNAIL') OR poster_status <> 'READY' THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'project poster pointer must reference its own READY image asset';
    END IF;
    PERFORM "canonical_assert_asset_ready"(checked_project."poster_asset_id");
  END IF;
  IF checked_project."current_webgl_deployment_id" IS NOT NULL THEN
	IF checked_project."status"::text NOT IN ('PUBLISHED', 'ARCHIVED') THEN
	  RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'project current WebGL pointer requires a PUBLISHED project';
	END IF;
    SELECT d."project_id", d."state"::text, d."staging_bucket", d."object_manifest"
    INTO deployment_project_id, deployment_state, deployment_staging_bucket, deployment_object_manifest
    FROM "webgl_deployments" d WHERE d."id" = checked_project."current_webgl_deployment_id";
    IF NOT FOUND OR deployment_project_id IS DISTINCT FROM checked_project."id" OR deployment_state <> 'READY'
       OR deployment_staging_bucket IS NOT NULL OR deployment_object_manifest IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'project current WebGL pointer must reference its own READY deployment';
    END IF;
    PERFORM "canonical_assert_webgl_deployment"(checked_project."current_webgl_deployment_id");
  END IF;
END
$function$;

CREATE FUNCTION "canonical_assert_exhibition_pointer"(checked_exhibition_id INTEGER)
RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
  checked_exhibition "exhibitions"%ROWTYPE;
  poster_project_id INTEGER;
  poster_exhibition_id INTEGER;
  poster_kind TEXT;
  poster_status TEXT;
BEGIN
  SELECT * INTO checked_exhibition FROM "exhibitions" WHERE "id" = checked_exhibition_id;
  IF NOT FOUND OR checked_exhibition."poster_asset_id" IS NULL THEN RETURN; END IF;
  SELECT a."project_id", a."exhibition_id", a."kind"::text, a."status"::text
  INTO poster_project_id, poster_exhibition_id, poster_kind, poster_status
  FROM "assets" a WHERE a."id" = checked_exhibition."poster_asset_id";
  IF NOT FOUND OR poster_project_id IS NOT NULL OR poster_exhibition_id IS DISTINCT FROM checked_exhibition."id"
     OR poster_kind <> 'POSTER' OR poster_status <> 'READY' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'exhibition poster pointer must reference its own READY POSTER asset';
  END IF;
  PERFORM "canonical_assert_asset_ready"(checked_exhibition."poster_asset_id");
  IF EXISTS (
    SELECT 1
    FROM "asset_representations" r
    LEFT JOIN "storage_buckets" registry ON registry."bucket" = r."bucket"
    WHERE r."asset_id" = checked_exhibition."poster_asset_id" AND r."state"::text = 'READY'
      AND r."role"::text IN ('ORIGINAL', 'CARD_480', 'DISPLAY_960')
      AND (registry."visibility"::text IS DISTINCT FROM 'PUBLIC'
        OR r."object_key" NOT LIKE 'public/images/%'
        OR r."publication_bucket" IS NOT NULL
        OR r."publication_object_key" IS NOT NULL)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'exhibition poster representations must remain in the public image namespace';
  END IF;
END
$function$;

CREATE FUNCTION "canonical_assert_asset_dependents"(checked_asset_id INTEGER)
RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
  dependent_id INTEGER;
  deployment_id TEXT;
BEGIN
  PERFORM "canonical_assert_asset_ready"(checked_asset_id);
  FOR dependent_id IN SELECT p."id" FROM "projects" p WHERE p."poster_asset_id" = checked_asset_id LOOP
    PERFORM "canonical_assert_project_pointers"(dependent_id);
  END LOOP;
  FOR dependent_id IN SELECT e."id" FROM "exhibitions" e WHERE e."poster_asset_id" = checked_asset_id LOOP
    PERFORM "canonical_assert_exhibition_pointer"(dependent_id);
  END LOOP;
  FOR deployment_id IN
    SELECT d."id" FROM "webgl_deployments" d
    JOIN "asset_representations" r ON r."id" = d."source_representation_id"
    WHERE r."asset_id" = checked_asset_id
  LOOP
    PERFORM "canonical_assert_webgl_deployment"(deployment_id);
  END LOOP;
END
$function$;

CREATE FUNCTION "canonical_asset_serialization_trigger"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  old_project_id INTEGER;
  new_project_id INTEGER;
BEGIN
	IF TG_OP <> 'INSERT' THEN old_project_id := OLD."project_id"; END IF;
	IF TG_OP <> 'DELETE' THEN new_project_id := NEW."project_id"; END IF;
	PERFORM "canonical_lock_project_ids"(old_project_id, new_project_id);
	IF TG_OP = 'INSERT' THEN PERFORM "canonical_lock_asset_ids"(NEW."id");
	ELSE PERFORM "canonical_lock_asset_ids"(OLD."id"); END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "assets_pointer_serialization"
BEFORE INSERT OR UPDATE OR DELETE ON "assets"
FOR EACH ROW EXECUTE FUNCTION "canonical_asset_serialization_trigger"();

CREATE FUNCTION "canonical_representation_serialization_trigger"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  deployment_id TEXT;
	old_project_id INTEGER;
	new_project_id INTEGER;
BEGIN
	IF TG_OP <> 'INSERT' THEN
	  SELECT a."project_id" INTO old_project_id FROM "assets" a WHERE a."id" = OLD."asset_id";
	END IF;
	IF TG_OP <> 'DELETE' THEN
	  SELECT a."project_id" INTO new_project_id FROM "assets" a WHERE a."id" = NEW."asset_id";
	END IF;
	PERFORM "canonical_lock_project_ids"(old_project_id, new_project_id);
  IF TG_OP = 'INSERT' THEN
    PERFORM "canonical_lock_asset_ids"(NEW."asset_id");
    FOR deployment_id IN SELECT d."id" FROM "webgl_deployments" d WHERE d."source_representation_id" = NEW."id" ORDER BY d."id" LOOP
      PERFORM "canonical_lock_deployment"(deployment_id);
    END LOOP;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM "canonical_lock_asset_ids"(OLD."asset_id");
    FOR deployment_id IN SELECT d."id" FROM "webgl_deployments" d WHERE d."source_representation_id" = OLD."id" ORDER BY d."id" LOOP
      PERFORM "canonical_lock_deployment"(deployment_id);
    END LOOP;
    RETURN OLD;
  END IF;
  PERFORM "canonical_lock_asset_ids"(OLD."asset_id", NEW."asset_id");
  FOR deployment_id IN
    SELECT d."id" FROM "webgl_deployments" d
    WHERE d."source_representation_id" IN (OLD."id", NEW."id") ORDER BY d."id"
  LOOP
    PERFORM "canonical_lock_deployment"(deployment_id);
  END LOOP;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "asset_representations_pointer_serialization"
BEFORE INSERT OR UPDATE OR DELETE ON "asset_representations"
FOR EACH ROW EXECUTE FUNCTION "canonical_representation_serialization_trigger"();

CREATE FUNCTION "canonical_deployment_serialization_trigger"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  old_asset_id INTEGER;
  new_asset_id INTEGER;
BEGIN
	PERFORM "canonical_lock_project_ids"(
	  CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD."project_id" END,
	  CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW."project_id" END
	);
  IF TG_OP <> 'INSERT' THEN
    SELECT r."asset_id" INTO old_asset_id FROM "asset_representations" r WHERE r."id" = OLD."source_representation_id";
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT r."asset_id" INTO new_asset_id FROM "asset_representations" r WHERE r."id" = NEW."source_representation_id";
  END IF;
  PERFORM "canonical_lock_asset_ids"(old_asset_id, new_asset_id);
  IF TG_OP = 'INSERT' THEN PERFORM "canonical_lock_deployment"(NEW."id");
  ELSIF TG_OP = 'DELETE' THEN PERFORM "canonical_lock_deployment"(OLD."id");
  ELSE PERFORM "canonical_lock_deployment_ids"(OLD."id", NEW."id"); END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "webgl_deployments_pointer_serialization"
BEFORE INSERT OR UPDATE OR DELETE ON "webgl_deployments"
FOR EACH ROW EXECUTE FUNCTION "canonical_deployment_serialization_trigger"();

CREATE FUNCTION "canonical_project_serialization_trigger"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  asset_to_lock INTEGER;
BEGIN
	PERFORM "canonical_lock_project_ids"(NEW."id");
  IF TG_OP = 'INSERT' THEN
    FOR asset_to_lock IN
      SELECT candidate.asset_id
      FROM (
        SELECT NEW."poster_asset_id" AS asset_id
        UNION
        SELECT r."asset_id"
        FROM "webgl_deployments" d
        JOIN "asset_representations" r ON r."id" = d."source_representation_id"
        WHERE d."id" = NEW."current_webgl_deployment_id"
      ) candidate
      WHERE candidate.asset_id IS NOT NULL
      ORDER BY candidate.asset_id
    LOOP
      PERFORM "canonical_lock_asset_ids"(asset_to_lock);
    END LOOP;
    PERFORM "canonical_lock_deployment"(NEW."current_webgl_deployment_id");
  ELSE
    FOR asset_to_lock IN
      SELECT candidate.asset_id
      FROM (
        SELECT OLD."poster_asset_id" AS asset_id
        UNION SELECT NEW."poster_asset_id"
        UNION
        SELECT r."asset_id"
        FROM "webgl_deployments" d
        JOIN "asset_representations" r ON r."id" = d."source_representation_id"
        WHERE d."id" IN (OLD."current_webgl_deployment_id", NEW."current_webgl_deployment_id")
      ) candidate
      WHERE candidate.asset_id IS NOT NULL
      ORDER BY candidate.asset_id
    LOOP
      PERFORM "canonical_lock_asset_ids"(asset_to_lock);
    END LOOP;
    PERFORM "canonical_lock_deployment_ids"(OLD."current_webgl_deployment_id", NEW."current_webgl_deployment_id");
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "projects_pointer_serialization"
BEFORE INSERT OR UPDATE ON "projects"
FOR EACH ROW EXECUTE FUNCTION "canonical_project_serialization_trigger"();

CREATE FUNCTION "canonical_exhibition_serialization_trigger"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN PERFORM "canonical_lock_asset_ids"(NEW."poster_asset_id");
  ELSE PERFORM "canonical_lock_asset_ids"(OLD."poster_asset_id", NEW."poster_asset_id"); END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "exhibitions_pointer_serialization"
BEFORE INSERT OR UPDATE OF "poster_asset_id" ON "exhibitions"
FOR EACH ROW EXECUTE FUNCTION "canonical_exhibition_serialization_trigger"();

CREATE OR REPLACE FUNCTION "canonical_asset_guard_trigger"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM "canonical_assert_asset_dependents"(NEW."id");
	IF TG_OP = 'UPDATE' AND OLD."project_id" IS DISTINCT FROM NEW."project_id" THEN
	  PERFORM "canonical_assert_project_publication"(OLD."project_id");
	END IF;
	PERFORM "canonical_assert_project_publication"(NEW."project_id");
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION "canonical_representation_guard_trigger"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
	old_project_id INTEGER;
	new_project_id INTEGER;
BEGIN
	IF TG_OP <> 'INSERT' THEN
	  SELECT a."project_id" INTO old_project_id FROM "assets" a WHERE a."id" = OLD."asset_id";
	END IF;
	IF TG_OP <> 'DELETE' THEN
	  SELECT a."project_id" INTO new_project_id FROM "assets" a WHERE a."id" = NEW."asset_id";
	END IF;
  IF TG_OP = 'DELETE' THEN
    PERFORM "canonical_assert_asset_dependents"(OLD."asset_id");
	PERFORM "canonical_assert_project_publication"(old_project_id);
    RETURN OLD;
  ELSIF TG_OP = 'INSERT' THEN
    PERFORM "canonical_assert_asset_dependents"(NEW."asset_id");
	PERFORM "canonical_assert_project_publication"(new_project_id);
    RETURN NEW;
  END IF;
  PERFORM "canonical_assert_asset_dependents"(OLD."asset_id");
  IF NEW."asset_id" IS DISTINCT FROM OLD."asset_id" THEN PERFORM "canonical_assert_asset_dependents"(NEW."asset_id"); END IF;
	PERFORM "canonical_assert_project_publication"(old_project_id);
	IF new_project_id IS DISTINCT FROM old_project_id THEN PERFORM "canonical_assert_project_publication"(new_project_id); END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION "canonical_webgl_deployment_guard_trigger"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  current_project_id INTEGER;
BEGIN
  PERFORM "canonical_assert_webgl_deployment"(NEW."id");
	IF TG_OP = 'UPDATE' AND OLD."project_id" IS DISTINCT FROM NEW."project_id" THEN
	  PERFORM "canonical_assert_project_publication"(OLD."project_id");
	END IF;
	PERFORM "canonical_assert_project_publication"(NEW."project_id");
  FOR current_project_id IN SELECT p."id" FROM "projects" p WHERE p."current_webgl_deployment_id" = NEW."id" LOOP
    PERFORM "canonical_assert_project_pointers"(current_project_id);
  END LOOP;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION "canonical_project_pointer_guard_trigger"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM "canonical_assert_project_pointers"(NEW."id");
	PERFORM "canonical_assert_project_publication"(NEW."id");
  RETURN NEW;
END
$function$;

DROP TRIGGER "projects_canonical_pointer_guard" ON "projects";
CREATE CONSTRAINT TRIGGER "projects_canonical_pointer_guard"
AFTER INSERT OR UPDATE ON "projects"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "canonical_project_pointer_guard_trigger"();

CREATE FUNCTION "canonical_submission_serialization_trigger"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
	IF TG_OP = 'INSERT' THEN PERFORM "canonical_lock_project_ids"(NEW."project_id");
	ELSIF TG_OP = 'DELETE' THEN PERFORM "canonical_lock_project_ids"(OLD."project_id");
	ELSE PERFORM "canonical_lock_project_ids"(OLD."project_id", NEW."project_id"); END IF;
	RETURN COALESCE(NEW, OLD);
END
$function$;

CREATE TRIGGER "project_submissions_publication_serialization"
BEFORE INSERT OR UPDATE OR DELETE ON "project_submissions"
FOR EACH ROW EXECUTE FUNCTION "canonical_submission_serialization_trigger"();

CREATE FUNCTION "canonical_submission_publication_guard_trigger"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
	IF TG_OP = 'DELETE' THEN
	  PERFORM "canonical_assert_project_publication"(OLD."project_id");
	  RETURN OLD;
	END IF;
	PERFORM "canonical_assert_project_publication"(NEW."project_id");
	IF TG_OP = 'UPDATE' AND OLD."project_id" IS DISTINCT FROM NEW."project_id" THEN
	  PERFORM "canonical_assert_project_publication"(OLD."project_id");
	END IF;
	RETURN NEW;
END
$function$;

CREATE CONSTRAINT TRIGGER "project_submissions_publication_guard"
AFTER INSERT OR UPDATE OR DELETE ON "project_submissions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "canonical_submission_publication_guard_trigger"();

CREATE OR REPLACE FUNCTION "canonical_exhibition_pointer_guard_trigger"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM "canonical_assert_exhibition_pointer"(NEW."id");
  RETURN NEW;
END
$function$;

-- Legacy rows are no longer needed once every check above succeeds. Drop
-- dependent child tables before their session root and enum.
-- Phase 1 keeps the master-compatible PUBLISHED default because its runtime
-- does not own publication. The final runtime is deployed and verified before
-- this contract boundary, so new projects may now enter the DRAFT workflow.
ALTER TABLE "projects" ALTER COLUMN "status" SET DEFAULT 'DRAFT'::"ProjectStatus";

-- Phase 1 called this a rolling URL window. The actual invariant is a
-- session-lifetime multipart capability budget, so contract the physical
-- names as well and discard the never-used per-user window index.
DROP INDEX "asset_upload_sessions_part_url_issue_window_idx";
ALTER TABLE "asset_upload_sessions"
  RENAME COLUMN "part_url_issue_window_count" TO "part_capability_issued_count";
ALTER TABLE "asset_upload_sessions"
  RENAME COLUMN "part_url_issue_window_started_at" TO "part_capability_first_issued_at";
ALTER TABLE "asset_upload_sessions"
  RENAME COLUMN "part_url_last_issued_at" TO "part_capability_last_issued_at";
ALTER TABLE "asset_upload_sessions"
  RENAME CONSTRAINT "asset_upload_sessions_part_url_issue_window_count_check"
  TO "asset_upload_sessions_part_capability_issued_count_check";

DROP TABLE "game_upload_active_sessions";
DROP TABLE "game_upload_part_claims";
DROP TABLE "game_upload_parts";
DROP TABLE "game_upload_sessions";
DROP TYPE "UploadKind";

DROP TABLE "migration_metrics";
DROP TABLE "canonical_object_relocations";

ALTER TABLE "projects"
  DROP COLUMN "webgl_entry_key";

ALTER TABLE "exhibitions"
  DROP COLUMN "poster_storage_key",
  DROP COLUMN "poster_original_name",
  DROP COLUMN "poster_mime_type",
  DROP COLUMN "poster_size_bytes",
  DROP COLUMN "poster_width",
  DROP COLUMN "poster_height",
  DROP COLUMN "poster_card_480_height",
  DROP COLUMN "poster_display_960_height";

ALTER TABLE "assets"
  DROP COLUMN "storage_key",
  DROP COLUMN "playback_storage_key",
  DROP COLUMN "mime_type",
  DROP COLUMN "playback_mime_type",
  DROP COLUMN "size_bytes",
  DROP COLUMN "width",
  DROP COLUMN "height",
  DROP COLUMN "card_480_height",
  DROP COLUMN "display_960_height",
  DROP COLUMN "playback_size_bytes",
  DROP COLUMN "playback_status",
  DROP COLUMN "playback_error",
  DROP COLUMN "is_public";

DROP TYPE "AssetPlaybackStatus";

-- Successful completion is durable only together with the destructive DDL.
UPDATE "release_contract_exception_receipts" SET "applied_at" = clock_timestamp()
WHERE "migration_name" = '20260822000002_canonical_asset_contract_image_bridge36';
UPDATE "release_contract_authorizations" SET "consumed_at" = clock_timestamp()
WHERE "migration_name" = '20260822000002_canonical_asset_contract_image_bridge36';

COMMIT;
