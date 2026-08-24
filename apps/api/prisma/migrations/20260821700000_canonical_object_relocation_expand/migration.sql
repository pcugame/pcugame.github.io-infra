-- Migration-only durable ledger for Phase-1 canonical object relocation.
-- Source objects remain untouched until the Phase-2 contract transaction has
-- proved every destination pointer committed successfully.
CREATE TABLE "canonical_object_relocations" (
  "id" TEXT NOT NULL,
  "work_kind" TEXT NOT NULL,
  "work_ref" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "source_bucket" TEXT NOT NULL,
  "source_object_key" TEXT NOT NULL,
  "destination_bucket" TEXT NOT NULL,
  "destination_object_key" TEXT NOT NULL,
  "size_bytes" BIGINT NOT NULL,
  "mime_type" TEXT NOT NULL,
  "checksum_sha256" TEXT,
  "state" TEXT NOT NULL DEFAULT 'PREPARED',
  "materialized_at" TIMESTAMP(3),
  "committed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "canonical_object_relocations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "canonical_object_relocations_identity_key" UNIQUE (
    "source_bucket", "source_object_key", "destination_bucket", "destination_object_key"
  ),
  CONSTRAINT "canonical_object_relocations_shape_check" CHECK (
    btrim("work_kind") <> '' AND btrim("work_ref") <> '' AND btrim("role") <> ''
    AND btrim("source_bucket") <> '' AND btrim("source_object_key") <> ''
    AND btrim("destination_bucket") <> '' AND btrim("destination_object_key") <> ''
    AND ("source_bucket", "source_object_key") <> ("destination_bucket", "destination_object_key")
    AND "size_bytes" > 0 AND btrim("mime_type") <> ''
    AND ("checksum_sha256" IS NULL OR "checksum_sha256" ~ '^[a-f0-9]{64}$')
    AND (
      ("state" = 'PREPARED' AND "materialized_at" IS NULL AND "committed_at" IS NULL)
      OR ("state" = 'MATERIALIZED' AND "materialized_at" IS NOT NULL AND "committed_at" IS NULL
        AND "checksum_sha256" IS NOT NULL)
      OR ("state" = 'COMMITTED' AND "materialized_at" IS NOT NULL AND "committed_at" IS NOT NULL
        AND "checksum_sha256" IS NOT NULL)
    )
  )
);

CREATE INDEX "canonical_object_relocations_state_idx"
  ON "canonical_object_relocations"("state", "updated_at");
CREATE INDEX "canonical_object_relocations_source_idx"
  ON "canonical_object_relocations"("source_bucket", "source_object_key");
CREATE INDEX "canonical_object_relocations_destination_idx"
  ON "canonical_object_relocations"("destination_bucket", "destination_object_key");
