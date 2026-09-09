BEGIN;
ALTER TABLE "assets" ADD CONSTRAINT "assets_material_owner_check" CHECK (
  "kind" NOT IN ('DOCUMENT', 'ATTACHMENT') OR ("project_id" IS NOT NULL AND "exhibition_id" IS NULL)
);
ALTER TABLE "asset_upload_sessions" ADD CONSTRAINT "asset_upload_sessions_material_shape_check" CHECK (
  "kind" NOT IN ('DOCUMENT', 'ATTACHMENT') OR ("project_id" IS NOT NULL AND "exhibition_id" IS NULL AND "total_bytes" BETWEEN 1 AND 52428800)
);
DROP INDEX "asset_upload_sessions_active_project_kind_key";
CREATE UNIQUE INDEX "asset_upload_sessions_active_project_kind_key"
  ON "asset_upload_sessions"("project_id", "kind")
  WHERE "project_id" IS NOT NULL AND "kind" NOT IN ('VIDEO', 'DOCUMENT', 'ATTACHMENT')
    AND "state" IN ('ALLOCATING', 'UPLOADING', 'COMPLETING', 'VERIFYING');
ALTER TABLE "project_submission_items" DROP CONSTRAINT "project_submission_items_slot_check";
ALTER TABLE "project_submission_items" ADD CONSTRAINT "project_submission_items_slot_check" CHECK (
  "slot" ~ '^(game|webgl|poster|video:[0-9]+|image:[0-9]+|document:[0-9]+|attachment:[0-9]+)$'
);
ALTER TABLE "project_submission_items" DROP CONSTRAINT "project_submission_items_kind_slot_check";
ALTER TABLE "project_submission_items" ADD CONSTRAINT "project_submission_items_kind_slot_check" CHECK (
  ("kind" = 'GAME' AND "slot" = 'game') OR ("kind" = 'WEBGL' AND "slot" = 'webgl')
  OR ("kind" = 'POSTER' AND "slot" = 'poster') OR ("kind" = 'VIDEO' AND "slot" ~ '^video:[0-9]+$')
  OR ("kind" = 'IMAGE' AND "slot" ~ '^image:[0-9]+$')
  OR ("kind" = 'DOCUMENT' AND "slot" ~ '^document:[0-9]+$')
  OR ("kind" = 'ATTACHMENT' AND "slot" ~ '^attachment:[0-9]+$')
);
-- Deferred checks permit the asset and its ORIGINAL to be created atomically.
CREATE FUNCTION check_project_material_representation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE checked_id INTEGER; checked_ids INTEGER[];
BEGIN
  IF TG_TABLE_NAME = 'assets' THEN checked_ids := ARRAY[COALESCE(NEW.id, OLD.id)];
  ELSIF TG_OP = 'UPDATE' THEN checked_ids := ARRAY[OLD.asset_id, NEW.asset_id];
  ELSE checked_ids := ARRAY[COALESCE(NEW.asset_id, OLD.asset_id)]; END IF;
  FOREACH checked_id IN ARRAY checked_ids LOOP
  IF EXISTS (SELECT 1 FROM assets a WHERE a.id = checked_id
      AND a.kind IN ('DOCUMENT', 'ATTACHMENT') AND a.status = 'READY') THEN
    IF NOT EXISTS (SELECT 1 FROM asset_representations r JOIN storage_buckets b ON b.bucket = r.bucket
        WHERE r.asset_id = checked_id AND r.role = 'ORIGINAL' AND r.state = 'READY'
          AND b.visibility = 'PROTECTED' AND r.size_bytes BETWEEN 1 AND 52428800)
      OR EXISTS (SELECT 1 FROM asset_representations r WHERE r.asset_id = checked_id AND r.role <> 'ORIGINAL') THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'READY material requires only a protected ORIGINAL of at most 50 MiB';
    END IF;
  END IF;
  END LOOP;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER project_material_asset_invariant
  AFTER INSERT OR UPDATE ON assets DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_project_material_representation();
CREATE CONSTRAINT TRIGGER project_material_representation_invariant
  AFTER INSERT OR UPDATE OR DELETE ON asset_representations DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_project_material_representation();
COMMIT;
