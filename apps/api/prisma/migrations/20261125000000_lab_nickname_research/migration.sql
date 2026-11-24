-- Additive metadata only; case bodies, hashes, results and prompts are preserved.
-- Explicit transaction prevents partial metadata/backfill application.
BEGIN;
ALTER TABLE "LabDataset" ADD COLUMN "datasetType" TEXT NOT NULL DEFAULT 'context_terms',
 ADD COLUMN "schemaVersion" TEXT NOT NULL DEFAULT '1';
UPDATE "LabDataset" SET "datasetType" = CASE WHEN version = '2' THEN 'nickname_legacy' ELSE 'context_terms' END,
 "schemaVersion" = version;
ALTER TABLE "LabTestCase" ADD COLUMN split TEXT, ADD COLUMN "familyId" TEXT;
CREATE INDEX "LabTestCase_datasetId_split_ordinal_idx" ON "LabTestCase"("datasetId", split, ordinal);
ALTER TABLE "LabRun" ADD COLUMN "datasetType" TEXT NOT NULL DEFAULT 'context_terms',
 ADD COLUMN "schemaVersion" TEXT NOT NULL DEFAULT '1',
 ADD COLUMN "evaluationProtocol" TEXT NOT NULL DEFAULT 'legacy-custom-v1', ADD COLUMN split TEXT;
UPDATE "LabRun" r SET "datasetType"=d."datasetType", "schemaVersion"=d."schemaVersion"
 FROM "LabDataset" d WHERE r."datasetId"=d.id;
COMMIT;
