CREATE TABLE "file_access_tokens" (
 "id" TEXT PRIMARY KEY, "session_id" TEXT, "bucket" TEXT NOT NULL,
 "object_key" TEXT NOT NULL, "deployment_id" TEXT, "expires_at" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "file_access_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "auth_sessions"("id") ON DELETE CASCADE
);
CREATE INDEX "file_access_tokens_expires_at_idx" ON "file_access_tokens"("expires_at");
