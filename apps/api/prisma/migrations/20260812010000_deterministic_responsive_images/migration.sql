-- Rendition identity is derived from the immutable canonical storage key.
-- Nullable heights are readiness markers for physically present derivatives.
ALTER TABLE "assets"
  ADD COLUMN "card_480_height" INTEGER,
  ADD COLUMN "display_960_height" INTEGER;

ALTER TABLE "exhibitions"
  ADD COLUMN "poster_card_480_height" INTEGER,
  ADD COLUMN "poster_display_960_height" INTEGER;

-- This simplification is gated on running before rendition inventory exists.
-- Never silently discard durable object references from an already-used table.
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM "image_renditions") THEN
    RAISE EXCEPTION
      'Cannot remove non-empty image_renditions; reconcile durable rendition inventory before migrating';
  END IF;
END
$migration$;

-- Canonical originals must never occupy the deterministic rendition namespace:
-- a subsequent rendition PUT would otherwise overwrite an original object.
-- These validated constraints intentionally make deployment fail if conflicting
-- legacy rows exist, so they can be investigated instead of silently admitted.
ALTER TABLE "assets"
  ADD CONSTRAINT "assets_storage_key_not_deterministic_rendition_check" CHECK (
    NOT (
      length("storage_key") > length('/__pcu_image_rendition__/v1/card-480.webp')
      AND right("storage_key", length('/__pcu_image_rendition__/v1/card-480.webp'))
        = '/__pcu_image_rendition__/v1/card-480.webp'
    )
    AND NOT (
      length("storage_key") > length('/__pcu_image_rendition__/v1/display-960.webp')
      AND right("storage_key", length('/__pcu_image_rendition__/v1/display-960.webp'))
        = '/__pcu_image_rendition__/v1/display-960.webp'
    )
  );

ALTER TABLE "exhibitions"
  ADD CONSTRAINT "exhibitions_poster_storage_key_not_deterministic_rendition_check" CHECK (
    "poster_storage_key" IS NULL
    OR (
      NOT (
        length("poster_storage_key") > length('/__pcu_image_rendition__/v1/card-480.webp')
        AND right("poster_storage_key", length('/__pcu_image_rendition__/v1/card-480.webp'))
          = '/__pcu_image_rendition__/v1/card-480.webp'
      )
      AND NOT (
        length("poster_storage_key") > length('/__pcu_image_rendition__/v1/display-960.webp')
        AND right("poster_storage_key", length('/__pcu_image_rendition__/v1/display-960.webp'))
          = '/__pcu_image_rendition__/v1/display-960.webp'
      )
    )
  );

DROP TABLE "image_renditions";
DROP TYPE "ImageRenditionProfile";
