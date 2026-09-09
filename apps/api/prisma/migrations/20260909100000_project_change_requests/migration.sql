ALTER TABLE "projects" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
CREATE TYPE "ProjectChangeKind" AS ENUM ('EDIT', 'DELETE');
CREATE TYPE "ProjectChangeState" AS ENUM ('DRAFT', 'PENDING', 'APPLYING', 'COMPLETED', 'REJECTED', 'CANCELLED', 'CONFLICT', 'FAILED');
CREATE TABLE "project_change_requests" (
 "id" TEXT NOT NULL PRIMARY KEY, "project_id" INTEGER, "original_project_id" INTEGER NOT NULL,
 "project_title" TEXT NOT NULL, "actor_id" INTEGER NOT NULL, "kind" "ProjectChangeKind" NOT NULL,
 "state" "ProjectChangeState" NOT NULL DEFAULT 'DRAFT', "base_version" INTEGER NOT NULL,
 "before" JSONB NOT NULL, "changes" JSONB NOT NULL, "reason" TEXT NOT NULL,
 "file_snapshot" JSONB NOT NULL DEFAULT '[]', "review_reason" TEXT, "reviewer_id" INTEGER, "error" TEXT, "staging_project_id" INTEGER,
 "submitted_at" TIMESTAMP(3), "reviewed_at" TIMESTAMP(3), "completed_at" TIMESTAMP(3),
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "project_change_requests_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE,
 CONSTRAINT "project_change_requests_staging_project_id_fkey" FOREIGN KEY ("staging_project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "project_change_requests_staging_project_id_key" ON "project_change_requests"("staging_project_id");
CREATE UNIQUE INDEX "project_change_requests_active_project_key" ON "project_change_requests"("project_id") WHERE "state" IN ('DRAFT','PENDING','APPLYING','FAILED');
CREATE INDEX "project_change_requests_state_created_at_idx" ON "project_change_requests"("state", "created_at");
CREATE INDEX "project_change_requests_actor_id_created_at_idx" ON "project_change_requests"("actor_id", "created_at");
CREATE INDEX "project_change_requests_original_project_id_created_at_idx" ON "project_change_requests"("original_project_id", "created_at");
