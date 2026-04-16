-- Replace legacy dummy student IDs (from 2020 import) with '?' placeholder.
-- These were previously sanitized at runtime in shared/student-id.ts.
UPDATE "ProjectMember"
SET "studentId" = '?'
WHERE "studentId" IN ('0000001', '0000002', '0000003', '0000004', '0000005', '0000006');
