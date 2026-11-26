-- Release 2. The former Lab writers must already be retired.
-- Accept fresh installations or the complete, restore-verified production snapshot.
BEGIN;
SET LOCAL lock_timeout = '15s';
LOCK TABLE "LabDataset", "LabTestCase", "LabRun", "LabResult", "LabHumanReview", "LabTrainingCandidate", "LabFamilySplit", "LabBertScore", "LabCurationExport", "LabRoleAudit", users IN ACCESS EXCLUSIVE MODE;
DO $guard$
DECLARE
  expected record;
  actual_count bigint;
  actual_hash text;
  total_rows bigint := 0;
  matched boolean := true;
BEGIN
  FOR expected IN SELECT * FROM (VALUES
    ('LabDataset', 1, '8319df076082e0d61f3f769e94cca40e1cac291a0d056909e497c5ae6ec2c2f1'),
    ('LabTestCase', 2, '6bbfec62936701785a39e59f370e5783b4e4f2be0e6a3506a79769d90e57422f'),
    ('LabRun', 3, '4aff4dd59a99a442522b60ce34426bc74cae9f977f313a5c0273ce5dc7f68c2d'),
    ('LabResult', 6, 'd6fcd37f5e563eb0262936eaaf57143b45ba872d8915561586a5380ea2eaebd0'),
    ('LabHumanReview', 7, 'da3e5b831c57f07229ff9c17eb4b0dbb4b18e07efc8ca53b938ff3feaaca5b09'),
    ('LabTrainingCandidate', 3, '5771de7e31859414a75a100f869b44c17d52435ed72d7b66664ef08dd14b39b1'),
    ('LabFamilySplit', 2, '11ba83670b2d258a61f4dfb4aca95ba01531866924ada676096d5d0e562a7348'),
    ('LabBertScore', 6, '3f6d6d482e11d794c645eca871cbd4ba7a7e2401bb8164d75cf860cd4e2340f1'),
    ('LabCurationExport', 1, '53747e07c7ba47094ae46fc914318ae53c2167d345de67567cd715ceaa8684af'),
    ('LabRoleAudit', 0, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  ) AS manifest(relation, rows, digest)
  LOOP
    EXECUTE format($sql$
      SELECT count(*), encode(sha256(convert_to(coalesce(string_agg(h, '' ORDER BY h COLLATE "C"), ''), 'UTF8')), 'hex')
      FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text, 'UTF8')), 'hex') AS h FROM %I t) hashes
    $sql$, expected.relation) INTO actual_count, actual_hash;
    total_rows := total_rows + actual_count;
    matched := matched AND actual_count = expected.rows AND actual_hash = expected.digest;
  END LOOP;
  IF total_rows > 0 AND NOT matched THEN
    RAISE EXCEPTION 'Lab state differs from verified restore. Preserve source and repeat reconciliation.';
  END IF;
  IF EXISTS (SELECT FROM users WHERE role='BETA_TESTER') THEN
    RAISE EXCEPTION 'Convert retired roles after disabling old writers, before cleanup.';
  END IF;
END $guard$;

DROP TABLE "LabBertScore", "LabTrainingCandidate", "LabCurationExport", "LabHumanReview",
  "LabResult", "LabRun", "LabTestCase", "LabDataset", "LabFamilySplit", "LabRoleAudit";
ALTER TYPE "UserRole" RENAME TO "RetiredUserRole";
CREATE TYPE "UserRole" AS ENUM ('USER', 'OPERATOR', 'ADMIN');
ALTER TABLE users ALTER COLUMN role DROP DEFAULT;
ALTER TABLE users ALTER COLUMN role TYPE "UserRole" USING (role::text::"UserRole");
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'USER'::"UserRole";
DROP TYPE "RetiredUserRole";
COMMIT;
