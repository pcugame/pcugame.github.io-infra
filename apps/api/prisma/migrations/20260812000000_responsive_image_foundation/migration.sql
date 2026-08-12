-- Add canonical image metadata without invalidating existing rows. Legacy
-- images remain usable while their nullable dimensions are backfilled.
ALTER TABLE "assets"
  ADD COLUMN "width" INTEGER,
  ADD COLUMN "height" INTEGER;

ALTER TABLE "exhibitions"
  ADD COLUMN "poster_width" INTEGER,
  ADD COLUMN "poster_height" INTEGER;

CREATE TYPE "ImageRenditionProfile" AS ENUM ('CARD_480', 'DISPLAY_960');

CREATE TABLE "image_renditions" (
  "id" SERIAL NOT NULL,
  "profile" "ImageRenditionProfile" NOT NULL,
  "storage_key" TEXT NOT NULL,
  "source_storage_key" TEXT NOT NULL,
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "mime_type" TEXT NOT NULL,
  "size_bytes" BIGINT NOT NULL,
  "asset_id" INTEGER,
  "exhibition_id" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "image_renditions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "image_renditions_owner_xor_check" CHECK (
    ("asset_id" IS NOT NULL AND "exhibition_id" IS NULL)
    OR ("asset_id" IS NULL AND "exhibition_id" IS NOT NULL)
  ),
  CONSTRAINT "image_renditions_asset_id_fkey"
    FOREIGN KEY ("asset_id") REFERENCES "assets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "image_renditions_exhibition_id_fkey"
    FOREIGN KEY ("exhibition_id") REFERENCES "exhibitions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "image_renditions_storage_key_key"
  ON "image_renditions"("storage_key");
CREATE UNIQUE INDEX "image_renditions_asset_id_profile_key"
  ON "image_renditions"("asset_id", "profile");
CREATE UNIQUE INDEX "image_renditions_exhibition_id_profile_key"
  ON "image_renditions"("exhibition_id", "profile");
CREATE INDEX "image_renditions_source_storage_key_idx"
  ON "image_renditions"("source_storage_key");
