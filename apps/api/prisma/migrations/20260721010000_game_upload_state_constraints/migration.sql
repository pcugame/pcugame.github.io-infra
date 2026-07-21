-- Keep the string-backed workflow column compatible with existing clients while
-- preventing out-of-band writers from introducing states the application cannot recover.
ALTER TABLE "game_upload_sessions"
ADD CONSTRAINT "game_upload_sessions_status_check"
CHECK ("status" IN ('PENDING', 'COMPLETING', 'COMPLETED', 'FAILED', 'CANCELLED'));

ALTER TABLE "game_upload_sessions"
ADD CONSTRAINT "game_upload_sessions_sizes_check"
CHECK ("total_bytes" > 0 AND "chunk_size_bytes" > 0 AND "total_chunks" > 0);

ALTER TABLE "game_upload_parts"
ADD CONSTRAINT "game_upload_parts_part_number_check"
CHECK ("part_number" > 0);
