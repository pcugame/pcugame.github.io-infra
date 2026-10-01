ALTER TABLE "projects" ADD COLUMN "webgl_display_mode" TEXT NOT NULL DEFAULT 'auto';
UPDATE "projects" SET "webgl_display_mode" = 'manual'
WHERE "webgl_display_width" IS NOT NULL AND "webgl_display_height" IS NOT NULL;
ALTER TABLE "projects" ADD CONSTRAINT "projects_webgl_display_mode_check"
CHECK ("webgl_display_mode" IN ('auto', 'manual', 'legacy'));
ALTER TABLE "projects" ADD CONSTRAINT "projects_webgl_manual_display_check"
CHECK ("webgl_display_mode" <> 'manual' OR ("webgl_display_width" IS NOT NULL AND "webgl_display_height" IS NOT NULL));
ALTER TABLE "webgl_deployments" ADD COLUMN "display_analysis" JSONB;
