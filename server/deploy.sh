#!/usr/bin/env bash
# deploy.sh — podman-native deployment script (no docker-compose needed)
# Usage: ./deploy.sh [up|down|drain|backup|release-*|logs|status]
# Requires: podman, .env file in the same directory as this script or DEPLOY_DIR env var
set -euo pipefail

# ── Configuration ──────────────────────────────────────────────
DEPLOY_DIR="${DEPLOY_DIR:-/srv/graduationproject_v2}"
ENV_FILE="${DEPLOY_DIR}/.env"
POD_NAME="graduationproject"
PG_CONTAINER="gp-postgres"
API_CONTAINER="gp-api"
GAME_WORKER_CONTAINER="gp-worker-game-validation"
WEBGL_WORKER_CONTAINER="gp-worker-webgl"
VIDEO_WORKER_CONTAINER="gp-worker-video"
IMAGE_WORKER_CONTAINER="gp-worker-image"
EXPORT_WORKER_CONTAINER="gp-worker-export"
PROJECT_PUBLICATION_WORKER_CONTAINER="gp-worker-project-publication"
PG_IMAGE="docker.io/library/postgres:16-alpine"
API_IMAGE="${API_IMAGE:-ghcr.io/pcugame/pcu-graduationproject-v2-api:latest}"
MIGRATION_IMAGE="${MIGRATION_IMAGE:-$API_IMAGE}"
PULL_API_IMAGE="${PULL_API_IMAGE:-true}"
PG_VOLUME="gp_pg_data"
API_BIND_HOST="${API_BIND_HOST:-127.0.0.1}"
HEALTHCHECK_TIMEOUT=90  # seconds
CUTOVER_STATE_DIR="${CUTOVER_STATE_DIR:-${DEPLOY_DIR}/cutover-state}"
RUNTIME_CONTAINERS=(
  "$API_CONTAINER" "$GAME_WORKER_CONTAINER" "$WEBGL_WORKER_CONTAINER"
  "$VIDEO_WORKER_CONTAINER" "$IMAGE_WORKER_CONTAINER" "$EXPORT_WORKER_CONTAINER"
  "$PROJECT_PUBLICATION_WORKER_CONTAINER"
)

# ── Load .env ──────────────────────────────────────────────────
load_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "ERROR: .env file not found at $ENV_FILE"
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
}

require_immutable_release_images() {
  for pair in "API_IMAGE=${API_IMAGE}" "MIGRATION_IMAGE=${MIGRATION_IMAGE}"; do
    local name="${pair%%=*}"
    local image="${pair#*=}"
    [[ "$image" == *@sha256:* || "$image" == *:sha-* || "$image" == localhost/*:rollback-* ]] || {
      echo "ERROR: $name must use an immutable digest or sha-* release tag: $image"
      return 1
    }
  done
}

database_url_in_pod() {
  echo "${DATABASE_URL//@postgres:/@127.0.0.1:}"
}

release_common_args() {
  local db_url
  db_url="$(database_url_in_pod)"
  RELEASE_CONTAINER_ARGS=(
    --rm --pod "$POD_NAME"
    -e "NODE_ENV=production"
    -e "DATABASE_URL=${db_url}"
    -e "LOG_LEVEL=${LOG_LEVEL:-info}"
    -e "S3_ENDPOINT=${S3_ENDPOINT}"
    -e "S3_PUBLIC_SIGNING_ENDPOINT=${S3_PUBLIC_SIGNING_ENDPOINT}"
    -e "S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT=${S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT}"
    -e "PUBLIC_ASSET_ORIGIN=${PUBLIC_ASSET_ORIGIN}"
    -e "S3_REGION=${S3_REGION:-garage}"
    -e "S3_ACCESS_KEY_ID=${S3_ACCESS_KEY_ID}"
    -e "S3_SECRET_ACCESS_KEY=${S3_SECRET_ACCESS_KEY}"
    -e "S3_BUCKET_PUBLIC=${S3_BUCKET_PUBLIC:-pcu-public}"
    -e "S3_BUCKET_PROTECTED=${S3_BUCKET_PROTECTED:-pcu-protected}"
    -e "S3_FORCE_PATH_STYLE=${S3_FORCE_PATH_STYLE:-true}"
    -v "${CUTOVER_STATE_DIR}:/release-state:rw,Z"
  )
  if [[ -n "${S3_TLS_CA_HOST_PATH:-}" ]]; then
    RELEASE_CONTAINER_ARGS+=(
      -e "NODE_EXTRA_CA_CERTS=/run/secrets/garage-ca.pem"
      -v "${S3_TLS_CA_HOST_PATH}:/run/secrets/garage-ca.pem:ro,Z"
    )
  fi
}

assert_postgres_running() {
  local state
  state=$(podman inspect --format '{{.State.Status}}' "$PG_CONTAINER" 2>/dev/null || echo missing)
  [[ "$state" == running ]] || {
    echo "ERROR: PostgreSQL must already be running for a release operation (state: $state)"
    return 1
  }
  wait_for_pg
}

assert_mutation_drained() {
  [[ -f "${CUTOVER_STATE_DIR}/mutation-drained" ]] || {
    echo "ERROR: mutation drain marker is absent; run '$0 drain' first"
    return 1
  }
  for ctr in "${RUNTIME_CONTAINERS[@]}"; do
    [[ "$(podman inspect --format '{{.State.Status}}' "$ctr" 2>/dev/null || echo missing)" != running ]] || {
      echo "ERROR: mutation-capable process is still running: $ctr"
      return 1
    }
  done
}

run_release_entry() {
  local entry="$1"
  shift
  load_env
  validate_production_boundaries
  require_immutable_release_images
  mkdir -p "$CUTOVER_STATE_DIR"
  assert_postgres_running
  release_common_args
  podman run "${RELEASE_CONTAINER_ARGS[@]}" --entrypoint node "$MIGRATION_IMAGE" "$entry" "$@"
}

validate_production_boundaries() {
  node - \
    "$S3_ENDPOINT" \
    "$S3_PUBLIC_SIGNING_ENDPOINT" \
    "$S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT" \
    "$PUBLIC_ASSET_ORIGIN" <<'NODE'
const names = [
  'S3_ENDPOINT',
  'S3_PUBLIC_SIGNING_ENDPOINT',
  'S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT',
  'PUBLIC_ASSET_ORIGIN',
];
const values = process.argv.slice(2);
const origins = new Map();
for (let index = 0; index < names.length; index += 1) {
  const name = names[index];
  const value = values[index] ?? '';
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    console.error(`ERROR: ${name} must be an exact HTTPS origin`);
    process.exit(1);
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.pathname !== '/'
    || parsed.search !== ''
    || parsed.hash !== ''
    || value.endsWith('/')
  ) {
    console.error(`ERROR: ${name} must be an exact HTTPS origin without credentials, path, query, fragment, or trailing slash`);
    process.exit(1);
  }
  const previous = origins.get(parsed.origin);
  if (previous) {
    console.error(`ERROR: ${name} normalized origin collides with ${previous}`);
    process.exit(1);
  }
  origins.set(parsed.origin, name);
}
NODE
  [[ "${S3_PRIVATE_NETWORK_CONFIRMED:-false}" == "true" ]] || {
    echo "ERROR: set S3_PRIVATE_NETWORK_CONFIRMED=true only after firewalling Garage S3 to this host; never expose Garage admin/management listeners"
    return 1
  }
  if [[ -n "${S3_TLS_CA_HOST_PATH:-}" && ! -f "$S3_TLS_CA_HOST_PATH" ]]; then
    echo "ERROR: S3_TLS_CA_HOST_PATH does not exist: $S3_TLS_CA_HOST_PATH"
    return 1
  fi
}

require_unsigned_integer() {
  local name="$1"
  local value="${!name:-}"
  [[ "$value" =~ ^[0-9]+$ ]] || {
    echo "ERROR: $name must be an unsigned integer"
    return 1
  }
}

require_exact_capacity_value() {
  local name="$1"
  local expected="$2"
  require_unsigned_integer "$name" || return 1
  [[ "${!name}" == "$expected" ]] || {
    echo "ERROR: $name must equal $expected for this release (got ${!name})"
    return 1
  }
}

# Fail before the current deployment is stopped when process limits cannot
# cover API-accepted work or when a worker destination lacks staging space.
# Garage is on the NAS, so its free bytes are measured there and attested here;
# the API host must never mount the raw Garage data volume to perform this check.
validate_capacity_boundaries() {
  local nas_export_host_path="$1"
  local gib=$((1024 * 1024 * 1024))
  local mib=$((1024 * 1024))

  for obsolete in DIRECT_UPLOAD_PART_URL_WINDOW_MS DIRECT_UPLOAD_PART_URL_MAX; do
    if [[ -n "${!obsolete+x}" ]]; then
      echo "ERROR: obsolete $obsolete is set; use DIRECT_UPLOAD_PART_URL_REFRESH_MAX=64"
      return 1
    fi
  done

  require_exact_capacity_value DIRECT_UPLOAD_PART_URL_REFRESH_MAX 64 || return 1
  require_exact_capacity_value DIRECT_UPLOAD_WORKER_TEMP_MAX_MB 6144 || return 1
  require_exact_capacity_value EXPORT_WORKER_MAX_OBJECT_BYTES 5368709120 || return 1
  require_exact_capacity_value EXPORT_WORKER_MAX_JOB_BYTES 34359738368 || return 1
  for name in UPLOAD_USER_GAME_MAX_MB UPLOAD_PRIVILEGED_GAME_MAX_MB \
    NAS_EXPORT_STAGING_HEADROOM_BYTES GARAGE_DEPLOYMENT_HEADROOM_BYTES \
    GARAGE_CAPACITY_ATTESTED_AVAILABLE_BYTES; do
    require_unsigned_integer "$name" || return 1
  done

  local max_accepted_archive_mb="$UPLOAD_USER_GAME_MAX_MB"
  if (( UPLOAD_PRIVILEGED_GAME_MAX_MB > max_accepted_archive_mb )); then
    max_accepted_archive_mb="$UPLOAD_PRIVILEGED_GAME_MAX_MB"
  fi
  if (( max_accepted_archive_mb > DIRECT_UPLOAD_WORKER_TEMP_MAX_MB )); then
    echo "ERROR: GAME/WEBGL accepted archive maximum exceeds the 6 GiB worker tmpfs budget"
    return 1
  fi
  if (( max_accepted_archive_mb * mib > EXPORT_WORKER_MAX_OBJECT_BYTES )); then
    echo "ERROR: accepted GAME/WebGL object maximum exceeds EXPORT_WORKER_MAX_OBJECT_BYTES"
    return 1
  fi
  if (( EXPORT_WORKER_MAX_JOB_BYTES < EXPORT_WORKER_MAX_OBJECT_BYTES )); then
    echo "ERROR: EXPORT_WORKER_MAX_JOB_BYTES must cover EXPORT_WORKER_MAX_OBJECT_BYTES"
    return 1
  fi
  if (( NAS_EXPORT_STAGING_HEADROOM_BYTES < 1 || GARAGE_DEPLOYMENT_HEADROOM_BYTES < 1 )); then
    echo "ERROR: NAS and Garage capacity headroom must each be positive"
    return 1
  fi

  [[ -d "$nas_export_host_path" ]] || {
    echo "ERROR: NAS export path does not exist for capacity preflight: $nas_export_host_path"
    return 1
  }
  local nas_available_kib
  nas_available_kib="$(df -Pk -- "$nas_export_host_path" | awk 'NR == 2 { print $4 }')"
  [[ "$nas_available_kib" =~ ^[0-9]+$ ]] || {
    echo "ERROR: could not determine NAS staging free space at $nas_export_host_path"
    return 1
  }
  local nas_available_bytes=$((nas_available_kib * 1024))
  local nas_required_bytes=$((EXPORT_WORKER_MAX_JOB_BYTES + NAS_EXPORT_STAGING_HEADROOM_BYTES))
  if (( nas_available_bytes < nas_required_bytes )); then
    echo "ERROR: NAS staging requires ${nas_required_bytes} free bytes; found ${nas_available_bytes}"
    return 1
  fi

  local garage_required_bytes=$((15 * gib + GARAGE_DEPLOYMENT_HEADROOM_BYTES))
  if (( GARAGE_CAPACITY_ATTESTED_AVAILABLE_BYTES < garage_required_bytes )); then
    echo "ERROR: Garage requires 15 GiB per WebGL deployment plus headroom (${garage_required_bytes} bytes); NAS attestation reports ${GARAGE_CAPACITY_ATTESTED_AVAILABLE_BYTES}"
    return 1
  fi
  echo "Capacity preflight passed: NAS staging=${nas_available_bytes} bytes, Garage attested=${GARAGE_CAPACITY_ATTESTED_AVAILABLE_BYTES} bytes."
}

do_capacity_preflight() {
  load_env
  local nas_export_host_path="${NAS_EXPORT_HOST_PATH:-/mnt/nas/pcu_storage/GraduationGame}"
  validate_capacity_boundaries "$nas_export_host_path"
}

# Validate every dedicated process before stopping the current deployment.
# In particular, a library-only image-worker module must not masquerade as a
# runnable worker and leave IMAGE/POSTER jobs permanently unprocessed.
validate_worker_entries() {
  local release_schema_phase="$1"
  podman run --rm --entrypoint node \
    -e "PCU_RELEASE_SCHEMA_PHASE=${release_schema_phase}" "$API_IMAGE" -e '
    const fs = require("node:fs");
    const entries = [
      "dist/game-validation-worker.js", "dist/webgl-worker.js",
      "dist/video-worker.js", "dist/image-worker.js", "dist/export-worker.js",
    ];
    if (process.env.PCU_RELEASE_SCHEMA_PHASE === "phase2") {
      entries.push("dist/project-publication-worker.js");
    }
    for (const entry of entries) {
      if (!fs.existsSync(entry)) throw new Error(`missing worker entry: ${entry}`);
      const source = fs.readFileSync(entry, "utf8");
      if (!source.includes("process.argv[1]")) throw new Error(`worker is not directly executable: ${entry}`);
    }
  '
}

validate_phase1_runtime_marker() {
  local marker
  marker="$(podman run --rm --entrypoint node "$API_IMAGE" dist/phase1-release-manifest.js)" || {
    echo "ERROR: Phase 1 image is missing the dedicated runtime manifest"
    return 1
  }
  [[ "$marker" == "PCU_PHASE1_RUNTIME_V1" ]] || {
    echo "ERROR: Phase 1 runtime manifest returned an unexpected marker"
    return 1
  }
}

validate_release_image_pair() {
  local release_schema_phase="$1"
  if [[ "${START_DEDICATED_WORKERS:-true}" == false ]]; then
    [[ "$release_schema_phase" == phase1 && "$API_IMAGE" == localhost/*:rollback-* ]] || {
      echo "ERROR: disabling dedicated workers is permitted only for the fenced Phase 1 old-image rollback"
      return 1
    }
    return 0
  fi
  [[ "$API_IMAGE" == "$MIGRATION_IMAGE" ]] || {
    echo "ERROR: $release_schema_phase requires API_IMAGE and MIGRATION_IMAGE to be the same immutable release artifact"
    return 1
  }
}

pull_release_images() {
  if [[ "$PULL_API_IMAGE" == "true" ]]; then
    podman pull -q "$API_IMAGE"
    if [[ "$MIGRATION_IMAGE" != "$API_IMAGE" ]]; then
      podman pull -q "$MIGRATION_IMAGE"
    fi
  else
    podman image inspect "$API_IMAGE" >/dev/null
    podman image inspect "$MIGRATION_IMAGE" >/dev/null
    echo "Using existing local API image: $API_IMAGE"
  fi
}

validate_release_artifacts() {
  local release_schema_phase="$1"
  [[ "$release_schema_phase" == phase1 || "$release_schema_phase" == phase2 ]] || {
    echo "ERROR: release artifact preflight requires phase1 or phase2"
    return 1
  }
  validate_release_image_pair "$release_schema_phase"
  pull_release_images
  if [[ "${START_DEDICATED_WORKERS:-true}" == true ]]; then
    if [[ "$release_schema_phase" == phase1 ]]; then
      validate_phase1_runtime_marker
    fi
    validate_worker_entries "$release_schema_phase"
  else
    echo "WARNING: Phase 1 runtime marker and dedicated workers are bypassed for explicitly authorized pre-contract legacy rollback"
  fi
  validate_release_entries
}

do_release_artifact_preflight() {
  local release_schema_phase="${1:-}"
  load_env
  validate_production_boundaries
  require_immutable_release_images
  validate_release_artifacts "$release_schema_phase"
  echo "$release_schema_phase release artifacts passed preflight without stopping the current deployment."
}

validate_release_entries() {
  podman run --rm --entrypoint node "$MIGRATION_IMAGE" -e '
    const fs = require("node:fs");
    const entries = [
      "dist-release/scripts/backfill-canonical-assets.js",
      "dist-release/scripts/preflight-canonical-contract.js",
      "dist-release/scripts/release-migrate.js",
      "dist-release/scripts/snapshot-garage-inventory.js",
      "dist-release/scripts/verify-cutover-report.js",
    ];
    for (const entry of entries) {
      if (!fs.existsSync(entry)) throw new Error(`missing compiled release CLI: ${entry}`);
    }
  '
}

# Stop every process that can mutate domain/object state while preserving the
# PostgreSQL container and pod for backups, audits, and explicit migrations.
do_drain() {
  load_env
  mkdir -p "$CUTOVER_STATE_DIR"
  for ctr in "${RUNTIME_CONTAINERS[@]}"; do
    podman stop "$ctr" --time 30 2>/dev/null || true
  done
  for ctr in "${RUNTIME_CONTAINERS[@]}"; do
    [[ "$(podman inspect --format '{{.State.Status}}' "$ctr" 2>/dev/null || echo missing)" != running ]] || {
      echo "ERROR: failed to drain mutation process $ctr"
      return 1
    }
  done
  {
    echo "drained_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "api_image=${API_IMAGE}"
  } > "${CUTOVER_STATE_DIR}/mutation-drained"
  chmod 600 "${CUTOVER_STATE_DIR}/mutation-drained"
  echo "Mutation drain complete; PostgreSQL remains online."
}

do_backup() {
  local label="${1:-manual}"
  load_env
  assert_postgres_running
  assert_mutation_drained
  [[ "$label" =~ ^[A-Za-z0-9._-]+$ ]] || {
    echo "ERROR: backup label contains unsupported characters"
    return 1
  }
  local backup_dir="${DEPLOY_DIR}/backups"
  local backup_file="${backup_dir}/${label}-$(date -u +%Y%m%dT%H%M%SZ).dump"
  umask 077
  mkdir -p "$backup_dir"
  if ! podman exec "$PG_CONTAINER" sh -c 'exec pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$backup_file"; then
    rm -f "$backup_file"
    echo "ERROR: PostgreSQL backup failed"
    return 1
  fi
  [[ -s "$backup_file" ]] || {
    rm -f "$backup_file"
    echo "ERROR: PostgreSQL backup is empty"
    return 1
  }
  sha256sum "$backup_file" > "${backup_file}.sha256"
  echo "PostgreSQL backup: $backup_file"
}

do_legacy_audit() {
  load_env
  assert_postgres_running
  assert_mutation_drained
  mkdir -p "$CUTOVER_STATE_DIR"
  local report="${CUTOVER_STATE_DIR}/legacy-audit-$(date -u +%Y%m%dT%H%M%SZ).tsv"
  podman exec -i "$PG_CONTAINER" psql \
    -X --set ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    --csv > "$report" <<'SQL'
SELECT 'assets_total' AS metric, count(*)::text AS value FROM assets
UNION ALL SELECT 'assets_with_storage_key', count(*)::text FROM assets WHERE storage_key IS NOT NULL
UNION ALL SELECT 'videos_with_playback_key', count(*)::text FROM assets WHERE playback_storage_key IS NOT NULL
UNION ALL SELECT 'projects_with_webgl_entry', count(*)::text FROM projects WHERE webgl_entry_key <> ''
UNION ALL SELECT 'active_legacy_upload_sessions', count(*)::text FROM game_upload_sessions
  WHERE status NOT IN ('COMPLETED', 'CANCELLED', 'FAILED', 'RESOLVED');
SQL
  chmod 600 "$report"
  echo "Legacy audit: $report"
}

do_release_migration() {
  local action="${1:-status}"
  [[ "$action" == status || "$action" == apply-expand || "$action" == apply-contract ]] || {
    echo "ERROR: release-migrate action must be status, apply-expand, or apply-contract"
    return 1
  }
  if [[ "$action" != status ]]; then
    assert_mutation_drained
  fi
  run_release_entry dist-release/scripts/release-migrate.js "$action"
}

do_release_assert() {
  local phase="${1:-}"
  [[ "$phase" == phase1 || "$phase" == phase2 ]] || {
    echo "ERROR: release-assert requires phase1 or phase2"
    return 1
  }
  run_release_entry dist-release/scripts/release-migrate.js assert-runtime "$phase"
}

do_inventory_snapshot() {
  assert_mutation_drained
  local output="${1:-/release-state/garage-inventory-$(date -u +%Y%m%dT%H%M%SZ).json}"
  [[ "$output" == /release-state/* ]] || {
    echo "ERROR: inventory output must be under /release-state"
    return 1
  }
  run_release_entry dist-release/scripts/snapshot-garage-inventory.js "--output=$output"
}

do_backfill() {
  assert_mutation_drained
  run_release_entry dist-release/scripts/backfill-canonical-assets.js "$@"
}

do_contract_preflight() {
  assert_mutation_drained
  run_release_entry dist-release/scripts/preflight-canonical-contract.js "$@"
}

do_mark_read_cutover() {
  load_env
  mkdir -p "$CUTOVER_STATE_DIR"
  [[ "$(podman inspect --format '{{.State.Status}}' "$API_CONTAINER" 2>/dev/null || echo missing)" == running ]] || {
    echo "ERROR: phase1 API is not running"
    return 1
  }
  [[ "$API_IMAGE" == "$MIGRATION_IMAGE" ]] || {
    echo "ERROR: refusing to record a mixed-image Phase 1 observation"
    return 1
  }
  validate_phase1_runtime_marker
  run_release_entry dist-release/scripts/release-migrate.js assert-runtime phase1
  podman exec "$API_CONTAINER" wget -qO- http://localhost:4000/api/health | grep -q '"ok":true'
  {
    echo "read_cutover_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "phase1_api_image=${API_IMAGE}"
    echo "migration_image=${MIGRATION_IMAGE}"
  } > "${CUTOVER_STATE_DIR}/phase1-observation"
  chmod 600 "${CUTOVER_STATE_DIR}/phase1-observation"
  echo "Canonical-first read cutover recorded. Observe zero fallback reads for at least 24 hours."
}

do_verify_final_web() {
  local expected_sha="${1:-}"
  load_env
  [[ "$expected_sha" =~ ^[0-9a-f]{40}$ ]] || {
    echo "ERROR: verify-final-web requires the exact 40-character lowercase Git commit SHA"
    return 1
  }
  EXPECTED_WEB_RELEASE_SHA="$expected_sha" WEB_RELEASE_BASE_URL="$WEB_PUBLIC_URL" node --input-type=module <<'NODE'
const expectedSha = process.env.EXPECTED_WEB_RELEASE_SHA;
const baseUrl = process.env.WEB_RELEASE_BASE_URL;
let url;
try {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('WEB_PUBLIC_URL must be an exact HTTPS origin');
  }
  url = new URL('/release-sha.txt', base);
} catch (error) {
  console.error(`ERROR: cannot construct final web release marker URL: ${error.message}`);
  process.exit(1);
}
const response = await fetch(url, {
  redirect: 'manual',
  cache: 'no-store',
  headers: {
    Accept: 'text/plain',
    'Accept-Encoding': 'identity',
    'Cache-Control': 'no-cache',
  },
  signal: AbortSignal.timeout(5000),
});
if (response.status !== 200) {
  throw new Error(`final web release marker returned HTTP ${response.status}; redirects are forbidden`);
}
const contentType = response.headers.get('content-type') ?? '';
if (!/^text\/plain(?:;\s*charset=utf-8)?$/i.test(contentType)) {
  throw new Error(`final web release marker has unexpected Content-Type ${contentType || '(missing)'}`);
}
const contentEncoding = response.headers.get('content-encoding');
if (contentEncoding !== null && contentEncoding.toLowerCase() !== 'identity') {
  throw new Error(`final web release marker ignored identity encoding: ${contentEncoding}`);
}
const expected = Buffer.from(`${expectedSha}\n`, 'utf8');
const declaredLength = response.headers.get('content-length');
if (declaredLength !== null && Number(declaredLength) !== expected.length) {
  throw new Error(`final web release marker has unexpected Content-Length ${declaredLength}`);
}
const reader = response.body?.getReader();
if (!reader) throw new Error('final web release marker has no response body');
const chunks = [];
let length = 0;
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  length += value.byteLength;
  if (length > expected.length) {
    await reader.cancel();
    throw new Error('final web release marker body is longer than the exact SHA marker');
  }
  chunks.push(Buffer.from(value));
}
const actual = Buffer.concat(chunks, length);
if (!actual.equals(expected)) {
  throw new Error('final web release marker does not exactly equal GITHUB_SHA followed by one LF');
}
console.log(`Final web release ${expectedSha} verified without redirect.`);
NODE
}

# ── Wait for PostgreSQL ────────────────────────────────────────
wait_for_pg() {
  echo "Waiting for PostgreSQL to be ready..."
  local elapsed=0
  while (( elapsed < HEALTHCHECK_TIMEOUT )); do
    # First check the container is actually running
    local state
    state=$(podman inspect --format '{{.State.Status}}' "$PG_CONTAINER" 2>/dev/null || echo "missing")
    if [[ "$state" == "exited" || "$state" == "dead" || "$state" == "missing" ]]; then
      echo "ERROR: PostgreSQL container is not running (state: $state)"
      podman logs "$PG_CONTAINER" --tail 30 2>/dev/null || true
      return 1
    fi
    if podman exec "$PG_CONTAINER" pg_isready -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" &>/dev/null; then
      echo "PostgreSQL is ready! (${elapsed}s)"
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  echo "ERROR: PostgreSQL did not become ready within ${HEALTHCHECK_TIMEOUT}s"
  podman logs "$PG_CONTAINER" --tail 30 2>/dev/null || true
  return 1
}

# ── Tear down ──────────────────────────────────────────────────
do_down() {
  echo "Stopping and removing containers..."

  # 1) Stop containers gracefully first, then force-remove
  for ctr in "${RUNTIME_CONTAINERS[@]}" "$PG_CONTAINER"; do
    podman stop "$ctr" --time 10 2>/dev/null || true
    podman rm -f "$ctr" 2>/dev/null || true
  done

  # 2) Stop and remove the pod (also removes its infra container)
  podman pod stop "$POD_NAME" --time 10 2>/dev/null || true
  podman pod rm -f "$POD_NAME" 2>/dev/null || true

  # 3) Verify nothing remains — if a container with our names still
  #    exists in any state (created/exited/dead), remove it by ID
  for ctr in "${RUNTIME_CONTAINERS[@]}" "$PG_CONTAINER"; do
    local cid
    cid=$(podman ps -a --filter "name=^${ctr}$" --format '{{.ID}}' 2>/dev/null || true)
    if [[ -n "$cid" ]]; then
      echo "WARNING: orphaned container $ctr ($cid) found, force-removing..."
      podman rm -f -t 0 "$cid" 2>/dev/null || true
    fi
  done

  # 4) Final pod cleanup
  if podman pod exists "$POD_NAME" 2>/dev/null; then
    echo "WARNING: orphaned pod '$POD_NAME' found, force-removing..."
    podman pod rm -f "$POD_NAME" 2>/dev/null || true
  fi

  echo "Down complete. (Volume '$PG_VOLUME' preserved)"
}

# ── Verify container is running ───────────────────────────────
verify_running() {
  local name="$1"
  local label="$2"
  sleep 1  # give podman a moment to update state
  local state
  state=$(podman inspect --format '{{.State.Status}}' "$name" 2>/dev/null || echo "missing")
  if [[ "$state" != "running" ]]; then
    echo "ERROR: $label failed to start (state: $state)"
    podman logs "$name" --tail 30 2>/dev/null || true
    return 1
  fi
  echo "$label is running."
}

# ── Bring up ───────────────────────────────────────────────────
do_up() {
  load_env
  validate_production_boundaries
  require_immutable_release_images
  mkdir -p "$CUTOVER_STATE_DIR"

  local release_schema_phase="${RELEASE_SCHEMA_PHASE:-}"
  [[ "$release_schema_phase" == phase1 || "$release_schema_phase" == phase2 ]] || {
    echo "ERROR: RELEASE_SCHEMA_PHASE must explicitly be phase1 or phase2"
    return 1
  }

  local nas_export_host_path="${NAS_EXPORT_HOST_PATH:-/mnt/nas/pcu_storage/GraduationGame}"
  local nas_export_container_path="${NAS_EXPORT_PATH:-/nas}"

  if [[ "${START_DEDICATED_WORKERS:-true}" == true ]]; then
    validate_capacity_boundaries "$nas_export_host_path"
  fi

  # Ensure volume exists
  podman volume inspect "$PG_VOLUME" &>/dev/null || podman volume create "$PG_VOLUME"

  # Pull latest images (-q: suppress per-layer progress — it lands on
  # stderr and pollutes CI logs with noisy "err:" lines via ssh-action.
  # Real pull errors still surface via exit code and set -e.)
  echo "Pulling images..."
  podman pull -q "$PG_IMAGE"
  validate_release_artifacts "$release_schema_phase"

  # Remove old containers/pod if they exist
  do_down

  # Small pause to let podman fully release resources
  sleep 2

  # Create pod with API port published only on loopback by default.
  # Public traffic should reach the API through the reverse proxy, not :4000.
  echo "Creating pod '$POD_NAME'..."
  podman pod create \
    --name "$POD_NAME" \
    -p "${API_BIND_HOST}:${API_PORT:-4000}:4000"

  # Start PostgreSQL (no --replace: we just ensured a clean state)
  echo "Starting PostgreSQL..."
  podman run -d \
    --pod "$POD_NAME" \
    --name "$PG_CONTAINER" \
    --restart unless-stopped \
    -e "POSTGRES_DB=${POSTGRES_DB}" \
    -e "POSTGRES_USER=${POSTGRES_USER}" \
    -e "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}" \
    -v "${PG_VOLUME}:/var/lib/postgresql/data:Z" \
    "$PG_IMAGE"

  # Verify PostgreSQL container is actually running
  verify_running "$PG_CONTAINER" "PostgreSQL"

  # Wait for PostgreSQL to accept connections
  wait_for_pg

  # Refuse to start application processes against the wrong schema phase.
  # This is intentionally separate from migration application.
  release_common_args
  podman run "${RELEASE_CONTAINER_ARGS[@]}" --entrypoint node "$MIGRATION_IMAGE" \
    dist-release/scripts/release-migrate.js assert-runtime "$release_schema_phase"

  # Fix DATABASE_URL: in a pod, containers share localhost
  # Replace the hostname 'postgres' with '127.0.0.1' since they're in the same pod
  local db_url="${DATABASE_URL//\@postgres:/\@127.0.0.1:}"
  local common_env=(
    -e "NODE_ENV=production"
    -e "DATABASE_URL=${db_url}"
    -e "LOG_LEVEL=${LOG_LEVEL:-info}"
    -e "S3_ENDPOINT=${S3_ENDPOINT}"
    -e "S3_PUBLIC_SIGNING_ENDPOINT=${S3_PUBLIC_SIGNING_ENDPOINT}"
    -e "S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT=${S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT}"
    -e "PUBLIC_ASSET_ORIGIN=${PUBLIC_ASSET_ORIGIN}"
    -e "S3_REGION=${S3_REGION:-garage}"
    -e "S3_ACCESS_KEY_ID=${S3_ACCESS_KEY_ID}"
    -e "S3_SECRET_ACCESS_KEY=${S3_SECRET_ACCESS_KEY}"
    -e "S3_BUCKET_PUBLIC=${S3_BUCKET_PUBLIC:-pcu-public}"
    -e "S3_BUCKET_PROTECTED=${S3_BUCKET_PROTECTED:-pcu-protected}"
    -e "S3_FORCE_PATH_STYLE=${S3_FORCE_PATH_STYLE:-true}"
    -e "API_PUBLIC_URL=${API_PUBLIC_URL}"
    -e "WEB_PUBLIC_URL=${WEB_PUBLIC_URL}"
    -e "CORS_ALLOWED_ORIGINS=${CORS_ALLOWED_ORIGINS}"
    -e "DIRECT_UPLOAD_PART_URL_REFRESH_MAX=${DIRECT_UPLOAD_PART_URL_REFRESH_MAX}"
    -e "UPLOAD_USER_GAME_MAX_MB=${UPLOAD_USER_GAME_MAX_MB}"
    -e "UPLOAD_PRIVILEGED_GAME_MAX_MB=${UPLOAD_PRIVILEGED_GAME_MAX_MB}"
    -e "DIRECT_UPLOAD_WORKER_TEMP_MAX_MB=${DIRECT_UPLOAD_WORKER_TEMP_MAX_MB}"
    -e "EXPORT_WORKER_MAX_OBJECT_BYTES=${EXPORT_WORKER_MAX_OBJECT_BYTES}"
    -e "EXPORT_WORKER_MAX_JOB_BYTES=${EXPORT_WORKER_MAX_JOB_BYTES}"
  )
  local ca_args=()
  if [[ -n "${S3_TLS_CA_HOST_PATH:-}" ]]; then
    common_env+=( -e "NODE_EXTRA_CA_CERTS=/run/secrets/garage-ca.pem" )
    ca_args=( -v "${S3_TLS_CA_HOST_PATH}:/run/secrets/garage-ca.pem:ro,Z" )
  fi

  # Start API (no --replace: we just ensured a clean state)
  echo "Starting API..."
  podman run -d \
    --pod "$POD_NAME" \
    --name "$API_CONTAINER" \
    --restart unless-stopped \
    "${common_env[@]}" \
    "${ca_args[@]}" \
    -e "PORT=4000" \
    -e "TRUST_PROXY=${TRUST_PROXY:-1}" \
    -e "DATABASE_URL=${db_url}" \
    -e "SESSION_SECRET=${SESSION_SECRET}" \
    -e "SESSION_COOKIE_NAME=${SESSION_COOKIE_NAME:-sid}" \
    -e "SESSION_IDLE_MS=${SESSION_IDLE_MS:-7200000}" \
    -e "SESSION_ABSOLUTE_MS=${SESSION_ABSOLUTE_MS:-1209600000}" \
    -e "SESSION_TOUCH_MIN_INTERVAL_MS=${SESSION_TOUCH_MIN_INTERVAL_MS:-300000}" \
    -e "SHUTDOWN_DRAIN_MS=${SHUTDOWN_DRAIN_MS:-15000}" \
    -e "COOKIE_SECURE=${COOKIE_SECURE:-true}" \
    -e "COOKIE_SAME_SITE=${COOKIE_SAME_SITE:-none}" \
    -e "GOOGLE_CLIENT_IDS=${GOOGLE_CLIENT_IDS}" \
    -e "ALLOWED_GOOGLE_HD=${ALLOWED_GOOGLE_HD:-}" \
    --entrypoint node \
    "$API_IMAGE" dist/server.js

  # Verify API container is actually running
  verify_running "$API_CONTAINER" "API"

  # Wait for API health check (DB + storage)
  echo "Waiting for API health check..."
  local api_elapsed=0
  local api_healthy=0
  while (( api_elapsed < HEALTHCHECK_TIMEOUT )); do
    if podman exec "$API_CONTAINER" wget -qO- http://localhost:4000/api/health 2>/dev/null | grep -q '"ok":true'; then
      echo "API health check passed! (${api_elapsed}s)"
      api_healthy=1
      break
    fi
    sleep 2
    api_elapsed=$((api_elapsed + 2))
  done
  if (( api_healthy == 0 )); then
    echo "ERROR: API health check did not pass within ${HEALTHCHECK_TIMEOUT}s"
    podman logs "$API_CONTAINER" --tail 30 2>/dev/null || true
    return 1
  fi

  start_worker() {
    local container="$1"
    local label="$2"
    local entry="$3"
    shift 3
    echo "Starting $label..."
    podman run -d \
      --pod "$POD_NAME" \
      --name "$container" \
      --restart unless-stopped \
      "${common_env[@]}" \
      "${ca_args[@]}" \
      "$@" \
      --entrypoint node \
      "$API_IMAGE" "$entry"
    verify_running "$container" "$label"
  }

  if [[ "${START_DEDICATED_WORKERS:-true}" == true ]]; then
    # These are independent, container-owned tmpfs mounts. They are neither a
    # shared host mount nor a shared 4 GiB pool between GAME and WebGL.
    start_worker "$GAME_WORKER_CONTAINER" "GAME validation worker" dist/game-validation-worker.js \
      --tmpfs /tmp:rw,noexec,nosuid,size=6g
    start_worker "$WEBGL_WORKER_CONTAINER" "WebGL worker" dist/webgl-worker.js \
      --tmpfs /tmp:rw,noexec,nosuid,size=6g
    start_worker "$VIDEO_WORKER_CONTAINER" "VIDEO worker" dist/video-worker.js \
      --tmpfs /tmp:rw,noexec,nosuid,size=2g
    start_worker "$IMAGE_WORKER_CONTAINER" "IMAGE/PDF worker" dist/image-worker.js \
      --tmpfs /tmp:rw,noexec,nosuid,size=512m
    start_worker "$EXPORT_WORKER_CONTAINER" "export worker" dist/export-worker.js \
      -e "NAS_EXPORT_ROOT=${nas_export_container_path}" \
      -v "${nas_export_host_path}:${nas_export_container_path}:rw,Z"
    if [[ "$release_schema_phase" == phase2 ]]; then
      start_worker "$PROJECT_PUBLICATION_WORKER_CONTAINER" "project publication worker" \
        dist/project-publication-worker.js
    fi
  fi

  # ── Generate systemd service with restart delay ──
  echo "Generating systemd service for pod..."
  local systemd_dir="$HOME/.config/systemd/user"
  mkdir -p "$systemd_dir"
  podman generate systemd --name "$POD_NAME" --files --new \
    --restart-policy=on-failure \
    -t 10 > /dev/null 2>&1 || true

  # Move generated files into systemd user directory
  for f in pod-${POD_NAME}.service container-*.service; do
    [[ -f "$f" ]] && mv -f "$f" "$systemd_dir/"
  done

  # Patch pod service with restart delay and burst limits
  local pod_service="$systemd_dir/pod-${POD_NAME}.service"
  if [[ -f "$pod_service" ]]; then
    sed -i '/^\[Service\]/a RestartSec=15' "$pod_service"
    sed -i '/^\[Unit\]/a StartLimitBurst=10\nStartLimitIntervalSec=300' "$pod_service"
    echo "Patched $pod_service with RestartSec=15, StartLimitBurst=10, StartLimitIntervalSec=300"
  else
    echo "WARNING: $pod_service not found, skipping restart-delay patch"
  fi

  # Reload and enable
  systemctl --user daemon-reload
  systemctl --user enable "pod-${POD_NAME}.service" 2>/dev/null || true
  echo "Systemd service enabled for pod '$POD_NAME'."

  echo ""
  echo "=== Forward-only deploy complete ==="
  echo "After a contract migration, failures require a forward fix or an explicit DB backup restore plus Garage reconciliation; this script never starts an old API automatically."
  podman pod ps --filter "name=$POD_NAME"
  echo ""
  podman ps --pod --filter "pod=$POD_NAME"
  rm -f "${CUTOVER_STATE_DIR}/mutation-drained"
}

# ── Logs ───────────────────────────────────────────────────────
do_logs() {
  local target="${1:-api}"
  case "$target" in
    api|app) podman logs -f "$API_CONTAINER" ;;
    pg|postgres|db) podman logs -f "$PG_CONTAINER" ;;
    game) podman logs -f "$GAME_WORKER_CONTAINER" ;;
    webgl) podman logs -f "$WEBGL_WORKER_CONTAINER" ;;
    video) podman logs -f "$VIDEO_WORKER_CONTAINER" ;;
    image) podman logs -f "$IMAGE_WORKER_CONTAINER" ;;
    export) podman logs -f "$EXPORT_WORKER_CONTAINER" ;;
    *) echo "Usage: $0 logs [api|pg|game|webgl|video|image|export]" ;;
  esac
}

# ── Status ─────────────────────────────────────────────────────
do_status() {
  echo "=== Pod ==="
  podman pod ps --filter "name=$POD_NAME" 2>/dev/null || echo "(no pod)"
  echo ""
  echo "=== Containers ==="
  podman ps -a --pod --filter "pod=$POD_NAME" 2>/dev/null || echo "(no containers)"
  echo ""
  echo "=== Volume ==="
  podman volume inspect "$PG_VOLUME" --format '{{.Name}} -> {{.Mountpoint}}' 2>/dev/null || echo "(no volume)"
}

# ── Main ───────────────────────────────────────────────────────
case "${1:-up}" in
  up)      do_up ;;
  down)    do_down ;;
  drain)   do_drain ;;
  backup)  do_backup "${2:-manual}" ;;
  legacy-audit) do_legacy_audit ;;
  release-migrate) do_release_migration "${2:-status}" ;;
  release-assert) do_release_assert "${2:-}" ;;
  inventory) do_inventory_snapshot "${2:-}" ;;
  backfill) shift; do_backfill "$@" ;;
  contract-preflight) shift; do_contract_preflight "$@" ;;
  capacity-preflight) do_capacity_preflight ;;
  boundary-preflight) load_env; validate_production_boundaries ;;
  release-artifact-preflight) do_release_artifact_preflight "${2:-}" ;;
  verify-final-web) do_verify_final_web "${2:-}" ;;
  mark-read-cutover) do_mark_read_cutover ;;
  # do_up validates every boundary before its own down/up replacement phase.
  restart) do_up ;;
  logs)    do_logs "${2:-api}" ;;
  status)  do_status ;;
  *)
    echo "Usage: $0 {up|down|drain|backup [label]|legacy-audit|release-migrate [status|apply-expand|apply-contract]|release-assert [phase1|phase2]|inventory [/release-state/file]|backfill [args...]|contract-preflight [args...]|capacity-preflight|boundary-preflight|release-artifact-preflight [phase1|phase2]|verify-final-web <git-sha>|mark-read-cutover|restart|logs [api|pg|game|webgl|video|image|export]|status}"
    exit 1
    ;;
esac
