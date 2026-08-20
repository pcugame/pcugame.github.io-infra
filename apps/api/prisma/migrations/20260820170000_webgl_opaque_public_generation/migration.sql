BEGIN;

ALTER TABLE "game_upload_sessions"
  ADD COLUMN "webgl_deployment_id" TEXT;

-- Historical READY WebGL deployments used the protected source UUID as the
-- public generation. Preserve those pointers while all new worker claims use
-- an independently generated opaque value.
UPDATE "game_upload_sessions"
SET "webgl_deployment_id" = (
  regexp_match(
    "storage_key",
    format(
      '^webgl/%s/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/source[.]zip$',
      "project_id"
    ),
    'i'
  )
)[1]
WHERE "upload_kind" = 'WEBGL'::"UploadKind"
  AND "status" = 'COMPLETED'
  AND "storage_key" IS NOT NULL;

ALTER TABLE "game_upload_sessions"
  ADD CONSTRAINT "game_upload_webgl_deployment_id_check"
  CHECK (
    "webgl_deployment_id" IS NULL
    OR (
      "upload_kind" = 'WEBGL'::"UploadKind"
      AND "webgl_deployment_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
  );

CREATE INDEX "game_upload_sessions_webgl_deployment_id_idx"
  ON "game_upload_sessions" ("project_id", "webgl_deployment_id")
  WHERE "webgl_deployment_id" IS NOT NULL;

COMMIT;
