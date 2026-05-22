ALTER TABLE "exhibitions"
  ADD COLUMN "poster_storage_key" TEXT,
  ADD COLUMN "poster_original_name" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "poster_mime_type" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "poster_size_bytes" BIGINT NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "exhibitions_poster_storage_key_key" ON "exhibitions"("poster_storage_key");
