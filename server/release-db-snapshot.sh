#!/usr/bin/env bash
# Online, self-contained PostgreSQL snapshot used before Phase 2 observation.
# It deliberately does not load DEPLOY_DIR/.env: database credentials stay in
# the already-running PostgreSQL container's environment.
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/srv/graduationproject_v2}"
PG_CONTAINER="${PG_CONTAINER:-gp-postgres}"
API_CONTAINER="gp-api"
REHEARSAL_IMAGE="docker.io/library/postgres:16-alpine"
SOURCE_REVISION="${1:-}"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

[[ $# -eq 1 ]] || die "usage: $0 <exact-lowercase-40-character-source-revision>"
[[ "$SOURCE_REVISION" =~ ^[0-9a-f]{40}$ ]] || die "source revision must be an exact lowercase 40-character SHA"
[[ "$PG_CONTAINER" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] || die "PG_CONTAINER must be a safe container name"
[[ "$DEPLOY_DIR" = /* ]] || die "DEPLOY_DIR must be an absolute path"

BACKUP_ROOT="${DEPLOY_DIR}/backups"
SNAPSHOT_DIR=""
REHEARSAL_CONTAINER=""
REHEARSAL_CREATED=false
COMPLETE=false
DUMP_VERIFIED=false
FAILED_STAGE="initialization"

write_failed_receipt() {
  [[ "$DUMP_VERIFIED" == true && -n "$SNAPSHOT_DIR" && -d "$SNAPSHOT_DIR" ]] || return 0
  local failed_at dump_sha256
  failed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  dump_sha256="$(awk '{print $1}' "${SNAPSHOT_DIR}/database.dump.sha256" 2>/dev/null || true)"
  [[ "$dump_sha256" =~ ^[0-9a-f]{64}$ ]] || dump_sha256="unavailable"
  printf '{\n  "snapshot_status": "failed",\n  "failed_at": "%s",\n  "failure_stage": "%s",\n  "control_source_revision": "%s",\n  "dump_file": "database.dump",\n  "dump_sha256": "%s"\n}\n' \
    "$failed_at" "$FAILED_STAGE" "$SOURCE_REVISION" "$dump_sha256" > "${SNAPSHOT_DIR}/receipt.json"
  chmod 600 "${SNAPSHOT_DIR}/receipt.json"
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  if [[ "$REHEARSAL_CREATED" == true ]]; then
    # This name is generated below; never remove a configured or pre-existing
    # container during failure handling.
    podman rm -f "$REHEARSAL_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [[ "$COMPLETE" != true ]]; then
    if [[ "$DUMP_VERIFIED" == true ]]; then
      write_failed_receipt || true
    elif [[ -n "$SNAPSHOT_DIR" && -d "$SNAPSHOT_DIR" ]]; then
      # Before pg_restore --list succeeds, this is only a partial or corrupt dump.
      rm -rf -- "$SNAPSHOT_DIR"
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

normalize_image_id() {
  local raw_id="$1"
  local image_id="${raw_id#sha256:}"
  [[ "$image_id" =~ ^[0-9a-f]{64}$ && ( "$raw_id" == "$image_id" || "$raw_id" == "sha256:${image_id}" ) ]] || \
    die "Podman returned a malformed gp-api image ID"
  printf '%s\n' "$image_id"
}

assert_postgres_online() {
  local state
  state="$(podman inspect --format '{{.State.Status}}' "$PG_CONTAINER" 2>/dev/null)" || die "PostgreSQL container is unavailable"
  [[ "$state" == running ]] || die "PostgreSQL must already be running (state: $state)"
  podman exec "$PG_CONTAINER" sh -c 'exec pg_isready -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1 || \
    die "PostgreSQL is not ready"
}

source_database_bytes() {
  local bytes
  bytes="$(podman exec -i "$PG_CONTAINER" sh -c 'exec psql -X -qAt --set ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' 2> "$SNAPSHOT_DIR/source-size.stderr" <<'SQL'
SELECT pg_database_size(current_database());
SQL
  )" || die "could not read the PostgreSQL database size"
  [[ "$bytes" =~ ^[0-9]+$ ]] || die "PostgreSQL returned an invalid database size"
  printf '%s\n' "$bytes"
}

assert_backup_space() {
  local source_bytes="$1" available_kib required_kib
  available_kib="$(df -Pk "$BACKUP_ROOT" | awk 'NR == 2 { print $4 }')"
  [[ "$available_kib" =~ ^[0-9]+$ ]] || die "could not determine free backup space"
  # A custom archive can approach database size. Reserve its size, 10% overhead,
  # and 64 MiB for checksums, receipts, and filesystem metadata.
  required_kib=$((source_bytes / 1024 + source_bytes / 10240 + 65536))
  (( available_kib >= required_kib )) || die "insufficient free space for the online database snapshot"
}

read_api_metadata() {
  API_IMAGE_ID="unavailable"
  API_IMAGE_DIGEST="unavailable"
  API_IMAGE_REVISION="unavailable"
  local raw_id raw_digest raw_revision
  if raw_id="$(podman inspect "$API_CONTAINER" --format '{{.Image}}' 2>/dev/null)"; then
    API_IMAGE_ID="$(normalize_image_id "$raw_id")"
    raw_digest="$(podman image inspect "$raw_id" --format '{{.Digest}}' 2>/dev/null || true)"
    if [[ -n "$raw_digest" ]]; then
      [[ "$raw_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die "gp-api image has a malformed digest"
      API_IMAGE_DIGEST="$raw_digest"
    fi
    raw_revision="$(podman image inspect "$raw_id" --format '{{ index .Labels "org.opencontainers.image.revision" }}' 2>/dev/null || true)"
    if [[ -n "$raw_revision" ]]; then
      [[ "$raw_revision" =~ ^[0-9a-f]{40}$ ]] || die "gp-api image has a malformed source revision label"
      API_IMAGE_REVISION="$raw_revision"
    fi
  fi
}

restore_table_counts() {
  podman exec -i "$REHEARSAL_CONTAINER" psql -X -qAt --set ON_ERROR_STOP=1 -U snapshot_restore -d snapshot_restore > "$SNAPSHOT_DIR/restored-table-counts.json" 2> "$SNAPSHOT_DIR/restored-table-counts.stderr" <<'SQL'
CREATE TEMP TABLE snapshot_table_counts (table_name text PRIMARY KEY, row_count bigint NOT NULL);
DO $$
DECLARE
  item record;
  rows bigint;
BEGIN
  FOR item IN
    SELECT n.nspname, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname !~ '^pg_'
      AND n.nspname <> 'information_schema'
    ORDER BY n.nspname, c.relname
  LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I', item.nspname, item.relname) INTO rows;
    INSERT INTO snapshot_table_counts VALUES (item.nspname || '.' || item.relname, rows);
  END LOOP;
END $$;
SELECT coalesce(jsonb_object_agg(table_name, row_count ORDER BY table_name), '{}'::jsonb)
FROM snapshot_table_counts;
SQL
}

restore_migration_state() {
  podman exec -i "$REHEARSAL_CONTAINER" psql -X -qAt --set ON_ERROR_STOP=1 -U snapshot_restore -d snapshot_restore > "$SNAPSHOT_DIR/restored-migrations.json" 2> "$SNAPSHOT_DIR/restored-migrations.stderr" <<'SQL'
CREATE TEMP TABLE snapshot_migrations (
  migration_name text NOT NULL,
  finished boolean NOT NULL,
  rolled_back boolean NOT NULL
);
DO $$
BEGIN
  IF to_regclass('public."_prisma_migrations"') IS NOT NULL THEN
    EXECUTE 'INSERT INTO snapshot_migrations
      SELECT migration_name, finished_at IS NOT NULL, rolled_back_at IS NOT NULL
      FROM public."_prisma_migrations" ORDER BY migration_name';
  END IF;
END $$;
SELECT coalesce(jsonb_agg(jsonb_build_object(
  'migration_name', migration_name,
  'finished', finished,
  'rolled_back', rolled_back
) ORDER BY migration_name), '[]'::jsonb)
FROM snapshot_migrations;
SQL
}

restore_migration_metrics() {
  podman exec -i "$REHEARSAL_CONTAINER" psql -X -qAt --set ON_ERROR_STOP=1 -U snapshot_restore -d snapshot_restore > "$SNAPSHOT_DIR/restored-migration-metrics.json" 2> "$SNAPSHOT_DIR/restored-migration-metrics.stderr" <<'SQL'
CREATE TEMP TABLE snapshot_migration_metrics (
  name text NOT NULL,
  scope text NOT NULL,
  value bigint NOT NULL,
  last_observed_at timestamp(3)
);
DO $$
BEGIN
  IF to_regclass('public.migration_metrics') IS NOT NULL THEN
    EXECUTE 'INSERT INTO snapshot_migration_metrics
      SELECT name, scope, value, last_observed_at
      FROM public.migration_metrics ORDER BY name, scope';
  END IF;
END $$;
SELECT coalesce(jsonb_agg(jsonb_build_object(
  'name', name,
  'scope', scope,
  'value', value,
  'last_observed_at', last_observed_at
) ORDER BY name, scope), '[]'::jsonb)
FROM snapshot_migration_metrics;
SQL
}

assert_postgres_online
umask 077
mkdir -p -m 700 "$BACKUP_ROOT"
SNAPSHOT_DIR="$(mktemp -d "${BACKUP_ROOT}/phase2-observation-${SOURCE_REVISION}-XXXXXXXX")"
chmod 700 "$SNAPSHOT_DIR"
SOURCE_BYTES="$(source_database_bytes)"
assert_backup_space "$SOURCE_BYTES"

DUMP_FILE="${SNAPSHOT_DIR}/database.dump"
FAILED_STAGE="online_dump"
if ! podman exec -i "$PG_CONTAINER" sh -c 'exec pg_dump --format=custom --lock-wait-timeout=10s -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$DUMP_FILE" 2> "$SNAPSHOT_DIR/pg_dump.stderr"; then
  die "online PostgreSQL dump failed"
fi
[[ -s "$DUMP_FILE" ]] || die "online PostgreSQL dump is empty"
chmod 600 "$DUMP_FILE"
sha256sum "$DUMP_FILE" > "${SNAPSHOT_DIR}/database.dump.sha256"
chmod 600 "${SNAPSHOT_DIR}/database.dump.sha256"
FAILED_STAGE="archive_verification"
podman exec -i "$PG_CONTAINER" sh -c 'exec pg_restore --list' < "$DUMP_FILE" > /dev/null 2> "$SNAPSHOT_DIR/archive-verify.stderr" || \
  die "PostgreSQL archive verification failed"
DUMP_VERIFIED=true

snapshot_token="${SNAPSHOT_DIR##*-}"
[[ "$snapshot_token" =~ ^[A-Za-z0-9]+$ ]] || die "generated snapshot token is invalid"
REHEARSAL_CONTAINER="pcu-snapshot-restore-${snapshot_token}"
FAILED_STAGE="rehearsal_container_start"
podman run -d --name "$REHEARSAL_CONTAINER" \
  --network none \
  --memory 1g --memory-swap 1g --cpus 1.0 --pids-limit 128 \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,nodev,noexec,size=768m \
  -v "${SNAPSHOT_DIR}:/snapshot:ro,Z" \
  -e POSTGRES_DB=snapshot_restore \
  -e POSTGRES_USER=snapshot_restore \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  "$REHEARSAL_IMAGE" > "$SNAPSHOT_DIR/rehearsal-container-id" 2> "$SNAPSHOT_DIR/rehearsal-container.stderr"
REHEARSAL_CREATED=true

FAILED_STAGE="rehearsal_readiness"
for _ in {1..30}; do
  if podman exec "$REHEARSAL_CONTAINER" pg_isready -q -U snapshot_restore -d snapshot_restore >/dev/null 2> "$SNAPSHOT_DIR/rehearsal-readiness.stderr"; then
    break
  fi
  sleep 1
done
podman exec "$REHEARSAL_CONTAINER" pg_isready -q -U snapshot_restore -d snapshot_restore >/dev/null 2>> "$SNAPSHOT_DIR/rehearsal-readiness.stderr" || \
  die "disposable PostgreSQL restore rehearsal did not become ready"
FAILED_STAGE="rehearsal_restore"
podman exec "$REHEARSAL_CONTAINER" sh -c \
  'exec pg_restore --exit-on-error --no-owner --no-privileges -U snapshot_restore -d snapshot_restore /snapshot/database.dump' > /dev/null 2> "$SNAPSHOT_DIR/rehearsal-restore.stderr" || \
  die "disposable PostgreSQL restore rehearsal failed"
FAILED_STAGE="restored_table_counts"
restore_table_counts || die "could not collect aggregate restored table counts"
FAILED_STAGE="restored_migrations"
restore_migration_state || die "could not collect restored migration state"
FAILED_STAGE="restored_migration_metrics"
restore_migration_metrics || die "could not collect restored migration metrics"
chmod 600 "$SNAPSHOT_DIR/restored-table-counts.json" "$SNAPSHOT_DIR/restored-migrations.json" "$SNAPSHOT_DIR/restored-migration-metrics.json"
read_api_metadata

DUMP_SHA256="$(awk '{print $1}' "${SNAPSHOT_DIR}/database.dump.sha256")"
[[ "$DUMP_SHA256" =~ ^[0-9a-f]{64}$ ]] || die "checksum command returned an invalid SHA-256"
CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "${SNAPSHOT_DIR}/receipt.json" <<EOF
{
  "created_at": "${CREATED_AT}",
  "control_source_revision": "${SOURCE_REVISION}",
  "pg_container": "${PG_CONTAINER}",
  "dump_file": "database.dump",
  "dump_sha256": "${DUMP_SHA256}",
  "archive_verified": true,
  "restore_rehearsal": true,
  "restored_table_counts": "restored-table-counts.json",
  "restored_migrations": "restored-migrations.json",
  "restored_migration_metrics": "restored-migration-metrics.json",
  "api_image_id": "${API_IMAGE_ID}",
  "api_image_digest": "${API_IMAGE_DIGEST}",
  "api_image_revision": "${API_IMAGE_REVISION}"
}
EOF
chmod 600 "${SNAPSHOT_DIR}/receipt.json"

COMPLETE=true
printf 'Online PostgreSQL snapshot verified: path=%s dump_sha256=%s restore_rehearsal=true api_image_id=%s api_image_digest=%s api_image_revision=%s\n' \
  "$SNAPSHOT_DIR" "$DUMP_SHA256" "$API_IMAGE_ID" "$API_IMAGE_DIGEST" "$API_IMAGE_REVISION"
