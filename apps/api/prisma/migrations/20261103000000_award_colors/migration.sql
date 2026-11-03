-- Additive and nullable: existing awards and old writers retain their default styling.
-- Keep column and validation atomic; no existing rows require a backfill.
BEGIN;
ALTER TABLE exhibition_awards ADD COLUMN color VARCHAR(7);
ALTER TABLE exhibition_awards ADD CONSTRAINT exhibition_awards_color_check
  CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$');
COMMIT;
