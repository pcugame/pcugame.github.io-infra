-- Enforce "at most one READY asset per (project, kind)" for replaceable kinds (GAME, VIDEO).
-- IMAGE/POSTER/THUMBNAIL are intentionally excluded — projects may have multiple IMAGEs.
-- POSTER uniqueness is already guaranteed by `projects.poster_asset_id` FK.
--
-- Prisma's schema DSL can't express a partial unique (WHERE ...), so this is hand-written SQL.
-- Table/column names follow @@map (snake_case).
--
-- Deploy risk: if historical data already violates this, CREATE UNIQUE INDEX fails
-- and `prisma migrate deploy` stops — safe failure. Clean up duplicates and re-deploy:
--   SELECT project_id, kind, COUNT(*) FROM assets
--   WHERE status = 'READY' AND kind IN ('GAME', 'VIDEO')
--   GROUP BY 1, 2 HAVING COUNT(*) > 1;
CREATE UNIQUE INDEX "asset_project_replaceable_ready_unique"
  ON "assets" ("project_id", "kind")
  WHERE "status" = 'READY' AND "kind" IN ('GAME', 'VIDEO');
