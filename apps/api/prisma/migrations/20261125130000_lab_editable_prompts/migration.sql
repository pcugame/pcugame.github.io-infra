-- Additive, single-statement atomic migration. NULL identifies historical runs whose
-- stage instructions were not snapshotted. Preserve their prompt hashes and history.
ALTER TABLE "LabRun"
  ADD COLUMN "actionPrompt" TEXT,
  ADD COLUMN "answerPrompt" TEXT;
