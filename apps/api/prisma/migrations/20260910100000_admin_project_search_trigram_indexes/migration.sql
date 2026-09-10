-- Additive indexes for the case-insensitive substring predicates used by the
-- administrative project search. The migration runner applies this file as a
-- single unit, so regular index creation preserves its established atomic path.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

-- pg_trgm is commonly installed in public, but an existing database may keep
-- extensions in another schema. Resolve the actual operator-class schema so
-- the indexes do not depend on search_path or a fixed extension location.
DO $migration$
DECLARE
  trgm_schema text;
BEGIN
  SELECT namespace.nspname
  INTO STRICT trgm_schema
  FROM pg_extension extension
  JOIN pg_namespace namespace ON namespace.oid = extension.extnamespace
  WHERE extension.extname = 'pg_trgm';

  EXECUTE format(
    'CREATE INDEX "exhibitions_title_trgm_idx" ON "exhibitions" USING GIN ("title" %I.gin_trgm_ops)',
    trgm_schema
  );
  EXECUTE format(
    'CREATE INDEX "projects_title_trgm_idx" ON "projects" USING GIN ("title" %I.gin_trgm_ops)',
    trgm_schema
  );
  EXECUTE format(
    'CREATE INDEX "projects_summary_trgm_idx" ON "projects" USING GIN ("summary" %I.gin_trgm_ops)',
    trgm_schema
  );
  EXECUTE format(
    'CREATE INDEX "project_members_name_trgm_idx" ON "project_members" USING GIN ("name" %I.gin_trgm_ops)',
    trgm_schema
  );
  EXECUTE format(
    'CREATE INDEX "project_members_student_id_trgm_idx" ON "project_members" USING GIN ("student_id" %I.gin_trgm_ops)',
    trgm_schema
  );
END
$migration$;
