-- Persist capability refresh accounting so API restarts and horizontally
-- scaled issuers cannot reset the abuse boundary. This migration follows the
-- legacy transport cutover and deliberately changes no historical migration.
BEGIN;

ALTER TABLE "game_upload_sessions"
  ADD COLUMN "part_url_issue_window_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "part_url_issue_window_started_at" TIMESTAMP(3),
  ADD COLUMN "part_url_last_issued_at" TIMESTAMP(3);

ALTER TABLE "game_upload_sessions"
  ADD CONSTRAINT "game_upload_sessions_part_url_issue_count_check"
  CHECK ("part_url_issue_window_count" >= 0);

COMMIT;
