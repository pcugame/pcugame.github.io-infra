-- Lab domain cleanup. Stop Lab API writers and benchmark workers before applying.
-- Only the explicitly retired dataset types and their dependent rows are deleted.
-- Phase 1 nickname bodies, hashes, run settings, results and history are immutable.
-- Transactional DDL/DML: any failed validation rolls back the entire cleanup.
BEGIN;
SET LOCAL lock_timeout = '10s';
LOCK TABLE "LabDataset", "LabTestCase", "LabRun", "LabResult" IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "LabDataset" WHERE "datasetType" NOT IN ('context_terms', 'nickname_legacy', 'nickname_risk'))
    OR EXISTS (SELECT 1 FROM "LabRun" r JOIN "LabDataset" d ON d.id=r."datasetId"
      WHERE r."datasetType" <> d."datasetType" OR r."schemaVersion" <> d."schemaVersion") THEN
    RAISE EXCEPTION 'Unrecognized or inconsistent Lab snapshot; reconcile before cleanup';
  END IF;
  IF EXISTS (SELECT 1 FROM "LabResult" WHERE status='RUNNING'
    AND "leaseUntil" > clock_timestamp() AT TIME ZONE 'UTC') THEN
    RAISE EXCEPTION 'Stop benchmark workers and wait for active leases to expire';
  END IF;
END $$;

DELETE FROM "LabResult" WHERE "datasetId" IN
  (SELECT id FROM "LabDataset" WHERE "datasetType" IN ('context_terms', 'nickname_legacy'));
DELETE FROM "LabRun" WHERE "datasetId" IN
  (SELECT id FROM "LabDataset" WHERE "datasetType" IN ('context_terms', 'nickname_legacy'));
DELETE FROM "LabTestCase" WHERE "datasetId" IN
  (SELECT id FROM "LabDataset" WHERE "datasetType" IN ('context_terms', 'nickname_legacy'));
DELETE FROM "LabDataset" WHERE "datasetType" IN ('context_terms', 'nickname_legacy');

ALTER TABLE "LabTestCase" RENAME COLUMN term TO nickname;
ALTER TABLE "LabTestCase" DROP COLUMN context, DROP COLUMN language;
ALTER TABLE "LabDataset" DROP COLUMN "datasetType",
  ALTER COLUMN version SET DEFAULT '3', ALTER COLUMN "schemaVersion" SET DEFAULT '3';
ALTER TABLE "LabRun" DROP COLUMN "datasetType",
  ALTER COLUMN "schemaVersion" SET DEFAULT '3',
  ALTER COLUMN "evaluationProtocol" SET DEFAULT 'nickname-risk-v1';

-- Do not rewrite a malformed Phase 1 case to make this migration succeed.
-- These validations intentionally follow DDL/DML so failure-path tests prove rollback.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "LabDataset" WHERE "schemaVersion" <> '3')
    OR EXISTS (SELECT 1 FROM "LabRun" WHERE "evaluationProtocol" <> 'nickname-risk-v1')
    OR EXISTS (SELECT 1 FROM "LabTestCase" WHERE (body->>'nickname') IS DISTINCT FROM nickname
      OR jsonb_typeof(body->'reference') IS DISTINCT FROM 'object'
      OR jsonb_typeof(body->'reference'->'expectedReason') IS DISTINCT FROM 'string'
      OR jsonb_typeof(body->'reference'->'expectedScore') IS DISTINCT FROM 'number')
    OR EXISTS (SELECT 1 FROM "LabResult" WHERE output IS NOT NULL
      AND (output->>'schemaVersion') IS DISTINCT FROM '2') THEN
    RAISE EXCEPTION 'Invalid Phase 1 nickname snapshot; cleanup rolled back';
  END IF;
END $$;
COMMIT;
