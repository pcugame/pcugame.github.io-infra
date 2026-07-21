-- Add independent GAME / WEBGL resumable upload sessions and the active
-- WebGL deployment pointer. Existing rows remain GAME sessions.
CREATE TYPE "UploadKind" AS ENUM ('GAME', 'WEBGL');

ALTER TABLE "projects"
ADD COLUMN "webgl_entry_key" TEXT NOT NULL DEFAULT '';

ALTER TABLE "game_upload_sessions"
ADD COLUMN "upload_kind" "UploadKind" NOT NULL DEFAULT 'GAME';

CREATE INDEX "game_upload_sessions_project_id_upload_kind_idx"
ON "game_upload_sessions"("project_id", "upload_kind");

ALTER TABLE "game_upload_active_sessions"
ADD COLUMN "upload_kind" "UploadKind" NOT NULL DEFAULT 'GAME';

ALTER TABLE "game_upload_active_sessions"
DROP CONSTRAINT "game_upload_active_sessions_pkey";

ALTER TABLE "game_upload_active_sessions"
ADD CONSTRAINT "game_upload_active_sessions_pkey"
PRIMARY KEY ("project_id", "upload_kind");
