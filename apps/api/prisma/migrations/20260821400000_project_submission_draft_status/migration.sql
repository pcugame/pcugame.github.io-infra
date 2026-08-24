-- PostgreSQL does not allow a newly-added enum label to be used by later DDL
-- in the same migration transaction. Keep this enum expansion as its own
-- deploy boundary before the project-submission tables. Phase 1 retains the
-- PUBLISHED default; the contract migration switches the final runtime to DRAFT.
ALTER TYPE "ProjectStatus" ADD VALUE IF NOT EXISTS 'DRAFT';
