-- Additive, atomic queue creation. No existing runs or datasets are rewritten or backfilled.
BEGIN;
CREATE TABLE "LabBertScore" (
  "runId" TEXT NOT NULL, "caseId" TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING', "inputHash" TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, "retryBase" INTEGER NOT NULL DEFAULT 0,
  "leaseToken" TEXT, "leaseUntil" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  precision DOUBLE PRECISION, recall DOUBLE PRECISION, f1 DOUBLE PRECISION,
  reason TEXT, identity JSONB, "completedAt" TIMESTAMP(3),
  CONSTRAINT "LabBertScore_pkey" PRIMARY KEY ("runId", "caseId"),
  CONSTRAINT "LabBertScore_result_fkey" FOREIGN KEY ("runId", "caseId") REFERENCES "LabResult"("runId", "caseId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "LabBertScore_status_nextAttemptAt_leaseUntil_idx" ON "LabBertScore"(status, "nextAttemptAt", "leaseUntil");
COMMIT;
