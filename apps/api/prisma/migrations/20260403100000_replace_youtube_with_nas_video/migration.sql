-- Replace YouTube URL with NAS-hosted video fields + legacy flag

-- Step 1: Add new columns with defaults
ALTER TABLE "projects" ADD COLUMN "is_legacy" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "projects" ADD COLUMN "video_url" TEXT NOT NULL DEFAULT '';
ALTER TABLE "projects" ADD COLUMN "video_mime_type" TEXT NOT NULL DEFAULT '';

-- Step 2: Drop the youtube_url column
ALTER TABLE "projects" DROP COLUMN "youtube_url";
