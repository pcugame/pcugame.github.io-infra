-- Additive only: legacy reviews/candidates/exports remain historical records.
BEGIN;
ALTER TABLE "LabRun" ADD COLUMN "feedbackPolicy" TEXT,
  ADD COLUMN "replayOf" TEXT, ADD COLUMN "replayIdentity" JSONB;
COMMIT;
