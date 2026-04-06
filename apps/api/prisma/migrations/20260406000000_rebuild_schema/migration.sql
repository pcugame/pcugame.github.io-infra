-- Migration: rebuild schema from TEXT-PK/years to INT-PK/exhibitions
-- This drops all old tables and recreates with the current schema.
-- Reason: schema.prisma diverged from migrations (TEXT→INT PKs, years→exhibitions rename,
-- new tables) without corresponding migration files.

-- ============================================================
-- 1. Drop all foreign keys
-- ============================================================
ALTER TABLE "game_upload_sessions" DROP CONSTRAINT IF EXISTS "game_upload_sessions_project_id_fkey";
ALTER TABLE "game_upload_sessions" DROP CONSTRAINT IF EXISTS "game_upload_sessions_user_id_fkey";
ALTER TABLE "auth_sessions" DROP CONSTRAINT IF EXISTS "auth_sessions_user_id_fkey";
ALTER TABLE "assets" DROP CONSTRAINT IF EXISTS "assets_project_id_fkey";
ALTER TABLE "project_members" DROP CONSTRAINT IF EXISTS "project_members_project_id_fkey";
ALTER TABLE "project_members" DROP CONSTRAINT IF EXISTS "project_members_user_id_fkey";
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_year_id_fkey";
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_creator_id_fkey";
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_poster_asset_id_fkey";

-- ============================================================
-- 2. Drop all tables
-- ============================================================
DROP TABLE IF EXISTS "game_upload_sessions" CASCADE;
DROP TABLE IF EXISTS "auth_sessions" CASCADE;
DROP TABLE IF EXISTS "upload_jobs" CASCADE;
DROP TABLE IF EXISTS "assets" CASCADE;
DROP TABLE IF EXISTS "project_members" CASCADE;
DROP TABLE IF EXISTS "projects" CASCADE;
DROP TABLE IF EXISTS "years" CASCADE;
DROP TABLE IF EXISTS "users" CASCADE;
DROP TABLE IF EXISTS "banned_ips" CASCADE;
DROP TABLE IF EXISTS "site_settings" CASCADE;

-- ============================================================
-- 3. Drop old enums (will be recreated)
-- ============================================================
DROP TYPE IF EXISTS "DownloadPolicy";
DROP TYPE IF EXISTS "UserRole";
DROP TYPE IF EXISTS "ProjectStatus";
DROP TYPE IF EXISTS "AssetKind";
DROP TYPE IF EXISTS "AssetStatus";
DROP TYPE IF EXISTS "Platform";

-- ============================================================
-- 4. Recreate enums
-- ============================================================
CREATE TYPE "UserRole" AS ENUM ('USER', 'OPERATOR', 'ADMIN');
CREATE TYPE "ProjectStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
CREATE TYPE "AssetKind" AS ENUM ('THUMBNAIL', 'IMAGE', 'POSTER', 'GAME');
CREATE TYPE "AssetStatus" AS ENUM ('READY', 'DELETING', 'DELETED', 'FAILED');
CREATE TYPE "Platform" AS ENUM ('PC', 'MOBILE', 'WEB');

-- ============================================================
-- 5. Recreate tables with INT autoincrement PKs
-- ============================================================
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "google_sub" TEXT NOT NULL,
    "email" TEXT NOT NULL DEFAULT '',
    "student_id" TEXT,
    "name" TEXT NOT NULL DEFAULT '',
    "picture" TEXT NOT NULL DEFAULT '',
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "exhibitions" (
    "id" SERIAL NOT NULL,
    "year" INTEGER NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "is_upload_enabled" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "exhibitions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "projects" (
    "id" SERIAL NOT NULL,
    "exhibition_id" INTEGER NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "is_legacy" BOOLEAN NOT NULL DEFAULT false,
    "video_url" TEXT NOT NULL DEFAULT '',
    "video_mime_type" TEXT NOT NULL DEFAULT '',
    "status" "ProjectStatus" NOT NULL DEFAULT 'DRAFT',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "github_url" TEXT NOT NULL DEFAULT '',
    "platforms" "Platform"[] DEFAULT ARRAY[]::"Platform"[],
    "poster_asset_id" INTEGER,
    "creator_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "project_members" (
    "id" SERIAL NOT NULL,
    "project_id" INTEGER NOT NULL,
    "user_id" INTEGER,
    "name" TEXT NOT NULL,
    "student_id" TEXT NOT NULL DEFAULT '',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "project_members_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "assets" (
    "id" SERIAL NOT NULL,
    "project_id" INTEGER NOT NULL,
    "kind" "AssetKind" NOT NULL,
    "status" "AssetStatus" NOT NULL DEFAULT 'READY',
    "storage_key" TEXT NOT NULL,
    "original_name" TEXT NOT NULL DEFAULT '',
    "mime_type" TEXT NOT NULL DEFAULT '',
    "size_bytes" BIGINT NOT NULL DEFAULT 0,
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "auth_sessions" (
    "id" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "upload_jobs" (
    "id" SERIAL NOT NULL,
    "storage_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "upload_jobs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "game_upload_sessions" (
    "id" TEXT NOT NULL,
    "project_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
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

CREATE TABLE "banned_ips" (
    "id" SERIAL NOT NULL,
    "ip" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "banned_ips_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "site_settings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "max_game_file_mb" INTEGER NOT NULL DEFAULT 5120,
    "max_chunk_size_mb" INTEGER NOT NULL DEFAULT 10,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "site_settings_pkey" PRIMARY KEY ("id")
);

-- ============================================================
-- 6. Indexes
-- ============================================================
CREATE UNIQUE INDEX "users_google_sub_key" ON "users"("google_sub");
CREATE UNIQUE INDEX "users_student_id_key" ON "users"("student_id");

CREATE INDEX "exhibitions_sort_order_year_idx" ON "exhibitions"("sort_order", "year");
CREATE UNIQUE INDEX "exhibitions_year_title_key" ON "exhibitions"("year", "title");

CREATE UNIQUE INDEX "projects_poster_asset_id_key" ON "projects"("poster_asset_id");
CREATE INDEX "projects_exhibition_id_status_sort_order_idx" ON "projects"("exhibition_id", "status", "sort_order");
CREATE INDEX "projects_status_idx" ON "projects"("status");
CREATE UNIQUE INDEX "projects_exhibition_id_slug_key" ON "projects"("exhibition_id", "slug");

CREATE INDEX "project_members_project_id_sort_order_idx" ON "project_members"("project_id", "sort_order");
CREATE INDEX "project_members_user_id_idx" ON "project_members"("user_id");

CREATE UNIQUE INDEX "assets_storage_key_key" ON "assets"("storage_key");
CREATE INDEX "assets_project_id_kind_status_idx" ON "assets"("project_id", "kind", "status");

CREATE INDEX "auth_sessions_user_id_idx" ON "auth_sessions"("user_id");
CREATE INDEX "auth_sessions_expires_at_idx" ON "auth_sessions"("expires_at");

CREATE INDEX "game_upload_sessions_project_id_idx" ON "game_upload_sessions"("project_id");
CREATE INDEX "game_upload_sessions_user_id_idx" ON "game_upload_sessions"("user_id");
CREATE INDEX "game_upload_sessions_status_expires_at_idx" ON "game_upload_sessions"("status", "expires_at");

CREATE UNIQUE INDEX "banned_ips_ip_key" ON "banned_ips"("ip");

-- ============================================================
-- 7. Foreign keys
-- ============================================================
ALTER TABLE "projects" ADD CONSTRAINT "projects_exhibition_id_fkey" FOREIGN KEY ("exhibition_id") REFERENCES "exhibitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "projects" ADD CONSTRAINT "projects_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "projects" ADD CONSTRAINT "projects_poster_asset_id_fkey" FOREIGN KEY ("poster_asset_id") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "assets" ADD CONSTRAINT "assets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "game_upload_sessions" ADD CONSTRAINT "game_upload_sessions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "game_upload_sessions" ADD CONSTRAINT "game_upload_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
