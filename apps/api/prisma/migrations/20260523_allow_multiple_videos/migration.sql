-- Allow multiple READY VIDEO assets per project while keeping GAME replace-only.
-- The previous partial unique index covered both GAME and VIDEO.

DROP INDEX IF EXISTS "asset_project_replaceable_ready_unique";

CREATE UNIQUE INDEX "asset_project_game_ready_unique"
  ON "assets" ("project_id", "kind")
  WHERE "status" = 'READY' AND "kind" = 'GAME';
