-- Rendition identity is derived from the immutable canonical storage key.
-- Nullable heights are readiness markers for physically present derivatives.
-- Every operation is transactional: a failed durable-reference precondition,
-- legacy constraint validation, or cleanup leaves the pre-migration schema and
-- reference inventory intact.
-- READ COMMITTED is required for the lock-then-check protocol below. Under
-- REPEATABLE READ or SERIALIZABLE, a snapshot fixed while waiting for the table
-- lock could miss the row committed by the writer that held the conflicting
-- lock. Override any session/user default before the first migration query.
BEGIN ISOLATION LEVEL READ COMMITTED;

-- Older feature deployments may have created the former rendition inventory.
-- Never silently discard its durable object references. Dynamic SQL is needed
-- so the same migration also works on the canonical fresh path, where the table
-- has never existed.
DO $migration$
DECLARE
  rendition_inventory REGCLASS := to_regclass('"image_renditions"');
  has_rendition_references BOOLEAN := FALSE;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION
      'Deterministic responsive image migration requires READ COMMITTED isolation';
  END IF;

  IF rendition_inventory IS NOT NULL THEN
    -- Hold the strongest table lock through the inventory check and DROP. This
    -- closes the check/drop race with legacy writers: an earlier INSERT commits
    -- before this check and is detected, while a later INSERT cannot commit into
    -- an inventory that this transaction is about to remove.
    EXECUTE format(
      'LOCK TABLE %s IN ACCESS EXCLUSIVE MODE',
      rendition_inventory
    );
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %s)',
      rendition_inventory
    ) INTO has_rendition_references;
  END IF;

  IF has_rendition_references THEN
    RAISE EXCEPTION
      'Cannot remove non-empty image_renditions; reconcile durable rendition inventory before migrating';
  END IF;
END
$migration$;

ALTER TABLE "assets"
  ADD COLUMN "card_480_height" INTEGER,
  ADD COLUMN "display_960_height" INTEGER;

ALTER TABLE "exhibitions"
  ADD COLUMN "poster_card_480_height" INTEGER,
  ADD COLUMN "poster_display_960_height" INTEGER;

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
  ADD CONSTRAINT "exhibitions_poster_key_not_deterministic_rendition_check" CHECK (
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

DROP TABLE IF EXISTS "image_renditions";
DROP TYPE IF EXISTS "ImageRenditionProfile";

COMMIT;
