-- Track S3 objects that leaked because a sync delete failed and couldn't be retried inline.
CREATE TABLE "orphan_objects" (
    "id"             SERIAL PRIMARY KEY,
    "bucket"         TEXT NOT NULL,
    "storage_key"    TEXT NOT NULL,
    "reason"         TEXT NOT NULL DEFAULT '',
    "attempt_count"  INTEGER NOT NULL DEFAULT 0,
    "last_tried_at"  TIMESTAMP(3),
    "last_error"     TEXT,
    "resolved_at"    TIMESTAMP(3),
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "orphan_bucket_storage_key" ON "orphan_objects" ("bucket", "storage_key");
CREATE INDEX "orphan_objects_resolved_at_idx" ON "orphan_objects" ("resolved_at");
