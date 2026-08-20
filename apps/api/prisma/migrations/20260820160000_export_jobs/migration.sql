BEGIN;

CREATE TABLE "export_jobs" (
  "id" TEXT NOT NULL,
  "requested_by_id" INTEGER NOT NULL,
  "year" INTEGER,
  "dry_run" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "progress" JSONB,
  "result" JSONB,
  "error" TEXT,
  "claim_token" TEXT,
  "claim_until" TIMESTAMP(3),
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "export_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "export_jobs_status_check" CHECK ("status" IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED')),
  CONSTRAINT "export_jobs_year_check" CHECK ("year" IS NULL OR "year" >= 2000)
);

CREATE INDEX "export_jobs_status_created_at_idx" ON "export_jobs" ("status", "created_at");
CREATE INDEX "export_jobs_claim_until_idx" ON "export_jobs" ("claim_until");
CREATE UNIQUE INDEX "export_jobs_single_active_idx" ON "export_jobs" ((true))
  WHERE "status" IN ('QUEUED', 'RUNNING');

COMMIT;
