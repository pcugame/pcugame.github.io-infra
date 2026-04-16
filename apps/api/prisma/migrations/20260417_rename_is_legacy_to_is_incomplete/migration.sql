-- Rename column: is_legacy → is_incomplete (preserves data)
ALTER TABLE "projects" RENAME COLUMN "is_legacy" TO "is_incomplete";
