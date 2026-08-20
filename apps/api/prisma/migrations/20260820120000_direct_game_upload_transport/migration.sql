-- Existing sessions keep the legacy byte-proxy transport so an in-flight
-- multipart generation is never reinterpreted after deployment. Application
-- code explicitly selects DIRECT_MULTIPART for every newly created session.
-- PostgreSQL DDL is kept atomic so a failed constraint/index change cannot
-- leave the enum or transport column partially installed.
BEGIN;

CREATE TYPE "GameUploadTransport" AS ENUM ('API_CHUNK_PROXY', 'DIRECT_MULTIPART');

ALTER TABLE "game_upload_sessions"
  ADD COLUMN "transport" "GameUploadTransport" NOT NULL DEFAULT 'API_CHUNK_PROXY';

-- VERIFYING is the durable PostgreSQL-backed validation queue. REJECTED is
-- reserved for deterministic validation failures after storage completion.
ALTER TABLE "game_upload_sessions"
  DROP CONSTRAINT "game_upload_sessions_status_check";

ALTER TABLE "game_upload_sessions"
  ADD CONSTRAINT "game_upload_sessions_status_check"
  CHECK ("status" IN (
    'PENDING', 'COMPLETING', 'VERIFYING', 'COMPLETED',
    'REJECTED', 'FAILED', 'CANCELLED', 'EXPIRED'
  ));

ALTER TABLE "game_upload_sessions"
  DROP CONSTRAINT "game_upload_sessions_active_source_identity_check";

ALTER TABLE "game_upload_sessions"
  ADD CONSTRAINT "game_upload_sessions_active_source_identity_check"
  CHECK (
    "status" NOT IN ('PENDING', 'COMPLETING', 'VERIFYING')
    OR "source_identity_algorithm" IS NOT NULL
  );

-- Legacy proxy sessions retain their synchronous terminal workflow. New
-- asynchronous lifecycle states cannot accidentally be assigned to them.
ALTER TABLE "game_upload_sessions"
  ADD CONSTRAINT "game_upload_sessions_transport_state_check"
  CHECK (
    "transport" = 'DIRECT_MULTIPART'
    OR "status" NOT IN ('VERIFYING', 'REJECTED')
  );

CREATE INDEX "game_upload_sessions_verification_claim_idx"
  ON "game_upload_sessions" ("status", "completion_claim_until", "updated_at")
  WHERE "status" = 'VERIFYING';

COMMIT;
