CREATE TYPE "AssetPlaybackStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

ALTER TABLE "assets"
  ADD COLUMN "playback_storage_key" TEXT,
  ADD COLUMN "playback_mime_type" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "playback_size_bytes" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "playback_status" "AssetPlaybackStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "playback_error" TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX "assets_playback_storage_key_key" ON "assets"("playback_storage_key");
