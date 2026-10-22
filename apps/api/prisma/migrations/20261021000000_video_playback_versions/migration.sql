BEGIN;
-- CreateTable
CREATE TABLE "video_playback_jobs" (
    "id" TEXT NOT NULL,
    "asset_id" INTEGER,
    "source_representation_id" TEXT NOT NULL,
    "source_bucket" TEXT NOT NULL,
    "source_object_key" TEXT NOT NULL,
    "source_version" TEXT NOT NULL,
    "source_sha256" TEXT,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "active" BOOLEAN NOT NULL DEFAULT false,
    "lease_token" TEXT,
    "lease_until" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_playback_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_playback_renditions" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "profile" TEXT NOT NULL,
    "attempt" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "checksum" TEXT,
    "size_bytes" BIGINT NOT NULL DEFAULT 0,
    "frame_rate" DOUBLE PRECISION,
    "width" INTEGER,
    "height" INTEGER,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_playback_renditions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "video_playback_jobs_state_lease_until_idx" ON "video_playback_jobs"("state", "lease_until");

-- CreateIndex
CREATE INDEX "video_playback_jobs_asset_id_active_idx" ON "video_playback_jobs"("asset_id", "active");

-- CreateIndex
CREATE INDEX "video_playback_renditions_bucket_object_key_idx" ON "video_playback_renditions"("bucket", "object_key");

-- CreateIndex
CREATE INDEX "video_playback_renditions_expires_at_idx" ON "video_playback_renditions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "video_playback_renditions_job_id_profile_attempt_key" ON "video_playback_renditions"("job_id", "profile", "attempt");

-- AddForeignKey
ALTER TABLE "video_playback_jobs" ADD CONSTRAINT "video_playback_jobs_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_playback_renditions" ADD CONSTRAINT "video_playback_renditions_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "video_playback_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


CREATE UNIQUE INDEX video_playback_jobs_one_pending ON video_playback_jobs(asset_id) WHERE state IN ('PENDING', 'RUNNING');
CREATE UNIQUE INDEX video_playback_jobs_one_active ON video_playback_jobs(asset_id) WHERE active;
ALTER TABLE video_playback_jobs ADD CONSTRAINT video_playback_jobs_state CHECK (state IN ('PENDING','RUNNING','READY','FAILED'));
ALTER TABLE video_playback_renditions ADD CONSTRAINT video_playback_renditions_state CHECK (state IN ('PENDING','READY','DELETED'));
ALTER TABLE video_playback_renditions ADD CONSTRAINT video_playback_renditions_bucket_fkey FOREIGN KEY (bucket) REFERENCES storage_buckets(bucket) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE video_playback_jobs ADD CONSTRAINT video_playback_jobs_active_ready CHECK (NOT active OR state = 'READY');
ALTER TABLE video_playback_jobs ADD CONSTRAINT video_playback_jobs_lease CHECK (state <> 'RUNNING' OR (lease_token IS NOT NULL AND lease_until IS NOT NULL));
ALTER TABLE video_playback_renditions ADD CONSTRAINT video_playback_renditions_profile CHECK (profile IN ('native', 'cap60', 'cap30', 'legacy'));
ALTER TABLE video_playback_jobs ADD CONSTRAINT video_playback_jobs_active_checksum CHECK (NOT active OR source_sha256 IS NOT NULL);
COMMIT;
