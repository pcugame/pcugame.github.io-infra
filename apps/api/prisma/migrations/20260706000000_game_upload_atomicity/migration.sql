-- CreateTable
CREATE TABLE "game_upload_parts" (
    "id" SERIAL NOT NULL,
    "session_id" TEXT NOT NULL,
    "part_number" INTEGER NOT NULL,
    "etag" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_upload_parts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_upload_active_sessions" (
    "project_id" INTEGER NOT NULL,
    "session_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_upload_active_sessions_pkey" PRIMARY KEY ("project_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "game_upload_parts_session_id_part_number_key" ON "game_upload_parts"("session_id", "part_number");

-- CreateIndex
CREATE INDEX "game_upload_parts_session_id_idx" ON "game_upload_parts"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_upload_active_sessions_session_id_key" ON "game_upload_active_sessions"("session_id");

-- Backfill multipart ETags from the legacy JSON column.
INSERT INTO "game_upload_parts" ("session_id", "part_number", "etag", "created_at", "updated_at")
SELECT
    s."id",
    (part.value->>'partNumber')::INTEGER,
    part.value->>'etag',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "game_upload_sessions" s
CROSS JOIN LATERAL jsonb_array_elements(
    CASE
        WHEN s."s3_part_etags" IS NOT NULL AND jsonb_typeof(s."s3_part_etags") = 'array'
        THEN s."s3_part_etags"
        ELSE '[]'::jsonb
    END
) AS part(value)
WHERE
    part.value ? 'partNumber'
    AND part.value ? 'etag'
    AND (part.value->>'partNumber') ~ '^[0-9]+$'
    AND part.value->>'etag' <> ''
ON CONFLICT DO NOTHING;

-- Keep only one active session per project and mark the rest cancelled.
WITH ranked AS (
    SELECT
        "id",
        "project_id",
        ROW_NUMBER() OVER (
            PARTITION BY "project_id"
            ORDER BY "created_at" DESC, "id" DESC
        ) AS rn
    FROM "game_upload_sessions"
    WHERE "status" IN ('PENDING', 'COMPLETING')
      AND "expires_at" > CURRENT_TIMESTAMP
)
UPDATE "game_upload_sessions" s
SET "status" = 'CANCELLED', "updated_at" = CURRENT_TIMESTAMP
FROM ranked r
WHERE s."id" = r."id" AND r.rn > 1;

WITH ranked AS (
    SELECT
        "id",
        "project_id",
        ROW_NUMBER() OVER (
            PARTITION BY "project_id"
            ORDER BY "created_at" DESC, "id" DESC
        ) AS rn
    FROM "game_upload_sessions"
    WHERE "status" IN ('PENDING', 'COMPLETING')
      AND "expires_at" > CURRENT_TIMESTAMP
)
INSERT INTO "game_upload_active_sessions" ("project_id", "session_id", "created_at", "updated_at")
SELECT "project_id", "id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM ranked
WHERE rn = 1;

-- AddForeignKey
ALTER TABLE "game_upload_parts" ADD CONSTRAINT "game_upload_parts_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "game_upload_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_upload_active_sessions" ADD CONSTRAINT "game_upload_active_sessions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_upload_active_sessions" ADD CONSTRAINT "game_upload_active_sessions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "game_upload_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
