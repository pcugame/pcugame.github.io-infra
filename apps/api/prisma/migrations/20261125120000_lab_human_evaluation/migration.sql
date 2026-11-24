-- Additive, atomic migration. No original dataset, response or Worker history is rewritten.
BEGIN;
ALTER TABLE "LabRun" ADD COLUMN "finalTest" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "LabHumanReview" (
  "id" TEXT PRIMARY KEY, "runId" TEXT NOT NULL, "caseId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL CHECK ("revision" > 0), "actorId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resultHash" TEXT NOT NULL, "resultSnapshot" JSONB NOT NULL, "body" JSONB NOT NULL,
  FOREIGN KEY ("runId", "caseId") REFERENCES "LabResult"("runId", "caseId") ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "LabHumanReview_runId_caseId_revision_key" ON "LabHumanReview"("runId", "caseId", "revision");
CREATE TABLE "LabTrainingCandidate" (
  "id" TEXT PRIMARY KEY, "reviewId" TEXT NOT NULL, "actorId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "contentHash" TEXT NOT NULL, "body" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft' CHECK ("status" IN ('draft', 'approved', 'rejected')),
  "decisions" JSONB NOT NULL DEFAULT '[]',
  FOREIGN KEY ("reviewId") REFERENCES "LabHumanReview"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "LabTrainingCandidate_reviewId_idx" ON "LabTrainingCandidate"("reviewId");
CREATE TABLE "LabFamilySplit" (
  "familyId" TEXT PRIMARY KEY, "split" TEXT NOT NULL CHECK ("split" IN ('train', 'validation', 'test')),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "LabCurationExport" (
  "id" TEXT PRIMARY KEY, "runId" TEXT NOT NULL, "actorId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('train', 'validation', 'test')), "files" JSONB NOT NULL, "manifest" JSONB NOT NULL,
  FOREIGN KEY ("runId") REFERENCES "LabRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "LabCurationExport_runId_createdAt_idx" ON "LabCurationExport"("runId", "createdAt");
COMMIT;
