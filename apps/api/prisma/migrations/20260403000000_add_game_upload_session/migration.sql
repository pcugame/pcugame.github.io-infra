-- CreateTable
CREATE TABLE "game_upload_sessions" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "original_name" TEXT NOT NULL,
    "total_bytes" BIGINT NOT NULL,
    "chunk_size_bytes" INTEGER NOT NULL,
    "total_chunks" INTEGER NOT NULL,
    "uploaded_chunks" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "staging_path" TEXT NOT NULL,
    "storage_key" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_upload_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "game_upload_sessions_project_id_idx" ON "game_upload_sessions"("project_id");

-- CreateIndex
CREATE INDEX "game_upload_sessions_user_id_idx" ON "game_upload_sessions"("user_id");

-- CreateIndex
CREATE INDEX "game_upload_sessions_status_expires_at_idx" ON "game_upload_sessions"("status", "expires_at");

-- AddForeignKey
ALTER TABLE "game_upload_sessions" ADD CONSTRAINT "game_upload_sessions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_upload_sessions" ADD CONSTRAINT "game_upload_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: add userId to project_members for membership-based access
ALTER TABLE "project_members" ADD COLUMN "user_id" TEXT;

-- CreateIndex
CREATE INDEX "project_members_user_id_idx" ON "project_members"("user_id");

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
