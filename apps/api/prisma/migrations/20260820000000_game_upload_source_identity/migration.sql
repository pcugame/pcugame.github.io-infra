-- A resumable session is bound to one immutable source-file identity. Existing
-- incomplete sessions predate that invariant and must fail closed.
ALTER TABLE "game_upload_sessions"
  ADD COLUMN "source_identity_algorithm" TEXT,
  ADD COLUMN "source_identity" TEXT,
  ADD COLUMN "source_identity_block_size_bytes" INTEGER,
  ADD COLUMN "source_identity_block_manifest" BYTEA;

ALTER TABLE "game_upload_parts"
  ADD COLUMN "content_sha256" TEXT;

UPDATE "game_upload_sessions"
SET "status" = CASE
  WHEN "status" = 'PENDING' THEN 'CANCELLED'
  WHEN "status" = 'COMPLETING' THEN 'FAILED'
  ELSE "status"
END,
"updated_at" = CURRENT_TIMESTAMP;

DELETE FROM "game_upload_active_sessions";

ALTER TABLE "game_upload_sessions"
  ADD CONSTRAINT "game_upload_sessions_source_identity_shape_check"
  CHECK (
    ("source_identity_algorithm" IS NULL
      AND "source_identity" IS NULL
      AND "source_identity_block_size_bytes" IS NULL
      AND "source_identity_block_manifest" IS NULL)
    OR
    ("source_identity_algorithm" = 'SHA256_BLOCK_MANIFEST_V1'
      AND "source_identity" ~ '^[a-f0-9]{64}$'
      AND "source_identity_block_size_bytes" = 1048576
      AND octet_length("source_identity_block_manifest") =
        CEIL("total_bytes"::numeric / 1048576)::integer * 32
      AND "chunk_size_bytes" % 1048576 = 0)
  );

ALTER TABLE "game_upload_sessions"
  ADD CONSTRAINT "game_upload_sessions_active_source_identity_check"
  CHECK (
    "status" NOT IN ('PENDING', 'COMPLETING')
    OR "source_identity_algorithm" IS NOT NULL
  );

ALTER TABLE "game_upload_parts"
  ADD CONSTRAINT "game_upload_parts_content_sha256_check"
  CHECK ("content_sha256" IS NULL OR "content_sha256" ~ '^[a-f0-9]{64}$');

CREATE OR REPLACE FUNCTION prevent_game_upload_source_identity_change()
RETURNS trigger AS $$
BEGIN
  IF OLD."source_identity_algorithm" IS DISTINCT FROM NEW."source_identity_algorithm"
    OR OLD."source_identity" IS DISTINCT FROM NEW."source_identity"
    OR OLD."source_identity_block_size_bytes" IS DISTINCT FROM NEW."source_identity_block_size_bytes"
    OR OLD."source_identity_block_manifest" IS DISTINCT FROM NEW."source_identity_block_manifest" THEN
    RAISE EXCEPTION 'upload session source identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER game_upload_sessions_source_identity_immutable
BEFORE UPDATE ON "game_upload_sessions"
FOR EACH ROW EXECUTE FUNCTION prevent_game_upload_source_identity_change();
