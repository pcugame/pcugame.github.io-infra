-- Add canonical image metadata without invalidating existing rows. Legacy
-- images remain usable while their nullable dimensions are backfilled.
-- Keep the migration atomic because a failure while altering the second owner
-- must not leave only one owner shape changed.
BEGIN;

ALTER TABLE "assets"
  ADD COLUMN "width" INTEGER,
  ADD COLUMN "height" INTEGER;

ALTER TABLE "exhibitions"
  ADD COLUMN "poster_width" INTEGER,
  ADD COLUMN "poster_height" INTEGER;

COMMIT;
