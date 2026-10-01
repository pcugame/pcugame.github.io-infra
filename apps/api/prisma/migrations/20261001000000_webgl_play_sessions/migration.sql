CREATE TABLE "webgl_play_sessions" (
 "id" TEXT PRIMARY KEY, "control_hash" TEXT NOT NULL UNIQUE, "asset_hash" TEXT NOT NULL UNIQUE,
 "session_id" TEXT REFERENCES "auth_sessions"("id") ON DELETE CASCADE,
 "project_id" INTEGER NOT NULL, "deployment_id" TEXT NOT NULL,
 "expires_at" TIMESTAMP(3) NOT NULL, "absolute_expires_at" TIMESTAMP(3) NOT NULL,
 "revoked_at" TIMESTAMP(3), "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "policy_version" INTEGER NOT NULL DEFAULT 0, "approved_origins" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
 CONSTRAINT "webgl_play_expiry_bounds" CHECK ("expires_at" <= "absolute_expires_at"),
 CONSTRAINT "webgl_play_hash_format" CHECK ("control_hash" ~ '^[a-f0-9]{64}$' AND "asset_hash" ~ '^[a-f0-9]{64}$')
);
CREATE INDEX "webgl_play_sessions_session_id_expires_at_idx" ON "webgl_play_sessions"("session_id", "expires_at");
CREATE INDEX "webgl_play_sessions_expires_at_idx" ON "webgl_play_sessions"("expires_at");
