-- PostgreSQL forbids using an enum value in the transaction that first adds
-- it. Keep this ALTER in its own Prisma migration boundary.
ALTER TYPE "ProjectSubmissionState" ADD VALUE 'FINALIZING' AFTER 'PENDING';
