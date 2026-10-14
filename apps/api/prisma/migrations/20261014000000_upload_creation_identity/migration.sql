-- Additive: old rows/writers retain NULL identity. No external references change.
-- One transaction avoids a partially installed create identity contract.
BEGIN;
ALTER TABLE "asset_upload_sessions"
  ADD COLUMN "client_upload_id" TEXT,
  ADD COLUMN "create_request_hash" TEXT;
CREATE UNIQUE INDEX "asset_upload_sessions_user_client_upload_key"
  ON "asset_upload_sessions" ("user_id", "client_upload_id");
ALTER TABLE "asset_upload_sessions"
  ADD CONSTRAINT "asset_upload_sessions_create_identity_check" CHECK (
    ("client_upload_id" IS NULL AND "create_request_hash" IS NULL)
    OR ("client_upload_id" IS NOT NULL AND "create_request_hash" IS NOT NULL
      AND "create_request_hash" ~ '^[a-f0-9]{64}$')
  );
COMMIT;
