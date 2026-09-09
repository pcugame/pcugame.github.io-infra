-- Operational release provenance, deliberately queried through raw SQL.
-- Empty on the normal contract path; never alters business or metric data.
BEGIN;
CREATE TABLE "release_contract_authorizations" (
  "migration_name" TEXT PRIMARY KEY,
  "exception_id" TEXT NOT NULL CHECK ("exception_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  "actor" TEXT NOT NULL CHECK ("actor" ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$'),
  "run_id" TEXT NOT NULL CHECK ("run_id" ~ '^[0-9]{1,30}$'),
  "scope" TEXT NOT NULL CHECK ("scope" = '24-hour-observation-age-only'),
  "source_sha" TEXT NOT NULL CHECK ("source_sha" ~ '^[0-9a-f]{40}$'),
  "image" TEXT NOT NULL CHECK ("image" ~ '^ghcr[.]io/pcugame/pcu-graduationproject-v2-api@sha256:[0-9a-f]{64}$'),
  "migration_checksum" TEXT NOT NULL CHECK ("migration_checksum" ~ '^[0-9a-f]{64}$'),
  "authorized_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP + INTERVAL '1 hour',
  "consumed_at" TIMESTAMPTZ,
  CHECK ("expires_at" > "authorized_at" AND "expires_at" <= "authorized_at" + INTERVAL '1 hour')
);
CREATE TABLE "release_contract_exception_receipts" (
  "migration_name" TEXT PRIMARY KEY REFERENCES "release_contract_authorizations" ("migration_name"),
  "exception_id" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "source_sha" TEXT NOT NULL,
  "image" TEXT NOT NULL,
  "migration_checksum" TEXT NOT NULL,
  "authorized_at" TIMESTAMPTZ NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "metrics" JSONB NOT NULL,
  "relocation_summary" JSONB NOT NULL,
  "applied_at" TIMESTAMPTZ
);
COMMIT;
