#!/usr/bin/env bash
# deploy.sh — release gates and systemd/Quadlet lifecycle orchestration
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
API_IMAGE="${API_IMAGE:-}"
MIGRATION_IMAGE="${MIGRATION_IMAGE:-$API_IMAGE}"
RELEASE_IMAGE_REPOSITORY="ghcr.io/pcugame/pcu-graduationproject-v2-api"
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

QUADLET_HELPERS="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/quadlet"
POD_UNIT=graduationproject-pod.service
PG_UNIT=gp-postgres.service
APP_UNITS=()
for ctr in "${RUNTIME_CONTAINERS[@]}"; do APP_UNITS+=("${ctr}.service"); done

load_runtime_env() {
  APP_RUNTIME_ENV_FILE="${APP_RUNTIME_ENV_FILE:-${DEPLOY_DIR}/runtime-env/common.env}"
  API_RUNTIME_ENV_FILE="${API_RUNTIME_ENV_FILE:-${DEPLOY_DIR}/runtime-env/api.env}"
  POSTGRES_RUNTIME_ENV_FILE="${POSTGRES_RUNTIME_ENV_FILE:-${DEPLOY_DIR}/runtime-env/postgres.env}"
  local assignments
  assignments="$(python3 "$QUADLET_HELPERS/runtime-env.py" "$APP_RUNTIME_ENV_FILE" "$API_RUNTIME_ENV_FILE" "$POSTGRES_RUNTIME_ENV_FILE")" || return 1
  eval "$assignments"
}

assert_quadlet_adopted() {
  QUADLET_DIR="${QUADLET_DIR:-${HOME}/.config/containers/systemd}"
  export API_IMAGE DEPLOY_DIR API_BIND_HOST APP_RUNTIME_ENV_FILE API_RUNTIME_ENV_FILE POSTGRES_RUNTIME_ENV_FILE
  local staging
  staging="$(mktemp -d)"
  if ! bash "$QUADLET_HELPERS/render.sh" "$staging/expected" || ! systemctl --user show-environment | python3 "$QUADLET_HELPERS/check-installed.py" "$staging/expected" "$QUADLET_DIR" --manager-env; then
    rm -rf "$staging"
    return 1
  fi
  rm -rf "$staging"
  local unit definition source fragment pending dropins
  for unit in "$POD_UNIT" "$PG_UNIT" "${APP_UNITS[@]}" gp-pg-data-volume.service; do
    definition="${unit%.service}.container"
    [[ "$unit" != "$POD_UNIT" ]] || definition=graduationproject.pod
    [[ "$unit" != gp-pg-data-volume.service ]] || definition=gp-pg-data.volume
    pending="$(systemctl --user show "$unit" --property=NeedDaemonReload --value)" || return 1
    dropins="$(systemctl --user show "$unit" --property=DropInPaths --value)" || return 1
    [[ "$pending" == no && -z "$dropins" ]] || {
      echo "ERROR: $unit has pending reload or unsupported service drop-ins"
      return 1
    }
    source="$(systemctl --user show "$unit" --property=SourcePath --value)" || return 1
    fragment="$(systemctl --user show "$unit" --property=FragmentPath --value)" || return 1
    [[ "$source" == "$QUADLET_DIR/$definition" && "$fragment" == */generator*/"$unit" ]] || {
      echo "ERROR: $unit must be the installed Quadlet-generated service (legacy generated units are unsupported)"
      return 1
    }
  done
  assert_foundation_active
  assert_postgres_running
}

assert_foundation_active() {
  local unit
  for unit in "$POD_UNIT" "$PG_UNIT"; do
    systemctl --user is-active --quiet "$unit" || {
      echo "ERROR: adopted pod and PostgreSQL must already be active; automatic first installation/cutover is unsupported"
      return 1
    }
  done
}

stop_application_units() {
  systemctl --user stop "${APP_UNITS[@]}" || return 1
  assert_application_stopped
}

runtime_container_state() {
  local state exists_status=0
  if state="$(podman inspect --format '{{.State.Status}}' "$1" 2>/dev/null)"; then
    echo "$state"
    return 0
  fi
  podman container exists "$1" 2>/dev/null || exists_status=$?
  [[ "$exists_status" == 1 ]] || { echo "ERROR: cannot verify container state: $1" >&2; return 1; }
  echo missing
}

assert_application_stopped() {
  local unit state ctr
  for unit in "${APP_UNITS[@]}"; do
    state="$(systemctl --user show "$unit" --property=ActiveState --value)" || return 1
    [[ "$state" == inactive ]] || { echo "ERROR: application service is not inactive: $unit"; return 1; }
  done
  for ctr in "${RUNTIME_CONTAINERS[@]}"; do
    state="$(runtime_container_state "$ctr")" || return 1
    [[ "$state" == missing || "$state" == exited || "$state" == dead ]] || {
      echo "ERROR: failed to drain mutation process $ctr (state: $state)"
      return 1
    }
  done
}

# ── Load .env ──────────────────────────────────────────────────
load_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "ERROR: .env file not found at $ENV_FILE"
    exit 1
  fi
  # The caller owns the selected source/artifact; a stale host .env cannot change it.
  local selected_api="$API_IMAGE" selected_migration="$MIGRATION_IMAGE" selected_source="${RELEASE_SOURCE_SHA:-}"
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  API_IMAGE="$selected_api"
  MIGRATION_IMAGE="$selected_migration"
  RELEASE_SOURCE_SHA="$selected_source"
  FILE_GATEWAY_SECRET="${FILE_GATEWAY_SECRET:-}"
  set +a
}

require_immutable_release_images() {
  [[ "${START_DEDICATED_WORKERS:-true}" == true ]] || {
    echo "ERROR: START_DEDICATED_WORKERS must be true; legacy runtime bypass is retired"
    return 1
  }
  for pair in "API_IMAGE=${API_IMAGE}" "MIGRATION_IMAGE=${MIGRATION_IMAGE}"; do
    local name="${pair%%=*}"
    local image="${pair#*=}"
    [[ "$image" =~ ^ghcr\.io/pcugame/pcu-graduationproject-v2-api@sha256:[0-9a-f]{64}$ ]] || {
      echo "ERROR: $name must use an immutable @sha256 release digest from the exact authorized repository ${RELEASE_IMAGE_REPOSITORY}@sha256:<64 lowercase hex>: $image"
      return 1
    }
  done
}

release_image_digest() {
  podman image inspect "$1" --format '{{.Digest}}'
}

validate_release_source_identity() {
  local image="$1"
  [[ "${RELEASE_SOURCE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || {
    echo "ERROR: RELEASE_SOURCE_SHA must be the exact lowercase 40-character source commit"
    return 1
  }
  local requested_digest="${image##*@}"
  local actual_digest
  actual_digest="$(release_image_digest "$image")"
  [[ "$actual_digest" == "$requested_digest" ]] || {
    echo "ERROR: pulled image digest does not match the authorized reference"
    return 1
  }
  local source_revision
  source_revision="$(podman image inspect "$image" --format '{{ index .Labels "org.opencontainers.image.revision" }}')"
  [[ "$source_revision" == "$RELEASE_SOURCE_SHA" ]] || {
    echo "ERROR: image source revision label does not match RELEASE_SOURCE_SHA"
    return 1
  }
}

database_url_in_pod() {
  # Quadlet pod AddHost resolves postgres; preserve the exact runtime URL.
  echo "$DATABASE_URL"
}

release_common_args() {
  local db_url
  db_url="$(database_url_in_pod)"
  RELEASE_CONTAINER_ARGS=(
    --rm --pod "$POD_NAME"
    --user 0:0
    -e "NODE_ENV=production"
    -e "DATABASE_URL=${db_url}"
    -e "LOG_LEVEL=${LOG_LEVEL:-info}"
    -e "SESSION_SECRET=${SESSION_SECRET}"
    -e "FILE_GATEWAY_SECRET=${FILE_GATEWAY_SECRET:-}"
    -e "GOOGLE_CLIENT_IDS=${GOOGLE_CLIENT_IDS}"
    -e "CORS_ALLOWED_ORIGINS=${CORS_ALLOWED_ORIGINS}"
    -e "API_PUBLIC_URL=${API_PUBLIC_URL}"
    -e "WEBGL_EXTERNAL_CONNECTIONS_ENABLED=${WEBGL_EXTERNAL_CONNECTIONS_ENABLED:-false}"
    -e "WEBGL_PLAY_ENABLED=${WEBGL_PLAY_ENABLED:-false}"
    -e "WEB_PUBLIC_URL=${WEB_PUBLIC_URL}"
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
  assert_application_stopped
}

run_release_entry() {
  local entry="$1"
  shift
  load_env
  require_immutable_release_images
  load_runtime_env
  validate_production_boundaries
  assert_quadlet_adopted
  validate_release_source_identity "$MIGRATION_IMAGE"
  mkdir -p "$CUTOVER_STATE_DIR"
  assert_postgres_running
  release_common_args
  podman run "${RELEASE_CONTAINER_ARGS[@]}" --entrypoint node "$MIGRATION_IMAGE" "$entry" "$@"
}

validate_production_boundaries() {
  node - "${TRUST_PROXY:-false}" <<'NODE' || return 1
const value = process.argv[2].trim();
if (value !== '' && value !== 'true' && value !== 'false' && !Number.isNaN(Number(value))) {
  console.error('ERROR: TRUST_PROXY numeric hop counts are unsupported; use false or the exact trusted proxy peer IP/CIDR (as observed by the API).');
  process.exit(1);
}
NODE
  [[ "${#FILE_GATEWAY_SECRET}" -ge 32 ]] || {
    echo "ERROR: FILE_GATEWAY_SECRET must contain at least 32 characters and match the NAS file gateways"
    return 1
  }
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
  load_runtime_env
  local nas_export_host_path="${NAS_EXPORT_HOST_PATH:-/mnt/nas/pcu_storage/GraduationGame}"
  validate_capacity_boundaries "$nas_export_host_path"
}

# Validate every dedicated process before stopping the current deployment.
# In particular, a library-only image-worker module must not masquerade as a
# runnable worker and leave IMAGE/POSTER jobs permanently unprocessed.
validate_worker_entries() {
  podman run --rm --entrypoint node "$API_IMAGE" -e '
    const fs = require("node:fs");
    const entries = [
      "dist/game-validation-worker.js", "dist/webgl-worker.js",
      "dist/video-worker.js", "dist/image-worker.js", "dist/export-worker.js",
      "dist/project-publication-worker.js",
    ];
    for (const entry of entries) {
      if (!fs.existsSync(entry)) throw new Error(`missing worker entry: ${entry}`);
      const source = fs.readFileSync(entry, "utf8");
      if (!source.includes("process.argv[1]")) throw new Error(`worker is not directly executable: ${entry}`);
    }
  '
}

validate_release_image_pair() {
  local release_schema_phase="$1"
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
  [[ "$release_schema_phase" == phase2 ]] || {
    echo "ERROR: release artifact preflight requires phase2"
    return 1
  }
  validate_release_image_pair "$release_schema_phase"
  pull_release_images
  validate_release_source_identity "$API_IMAGE"
  validate_worker_entries
  validate_release_entries
}

do_release_artifact_preflight() {
  local release_schema_phase="${1:-}"
  load_env
  require_immutable_release_images
  [[ "$release_schema_phase" == phase2 ]] || { echo "ERROR: release artifact preflight requires phase2"; return 1; }
  load_runtime_env
  validate_production_boundaries
  validate_capacity_boundaries "${NAS_EXPORT_HOST_PATH:-/mnt/nas/pcu_storage/GraduationGame}"
  assert_quadlet_adopted
  validate_release_artifacts "$release_schema_phase"
  echo "$release_schema_phase release artifacts passed preflight without stopping the current deployment."
}

validate_release_entries() {
  podman run --rm --entrypoint node "$MIGRATION_IMAGE" -e '
    const fs = require("node:fs");
    const entries = [
      "dist-release/scripts/release-migrate.js",
      "dist-release/scripts/snapshot-garage-inventory.js",
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
  require_immutable_release_images
  load_runtime_env
  assert_quadlet_adopted
  mkdir -p "$CUTOVER_STATE_DIR"
  rm -f "${CUTOVER_STATE_DIR}/mutation-drained"
  stop_application_units
  assert_postgres_running
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
  load_runtime_env
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

do_release_migration() {
  local action="${1:-status}"
  if (( $# > 0 )); then shift; fi
  [[ "$action" == status || "$action" == apply-contract ]] || {
    echo "ERROR: release-migrate action must be status or apply-contract"
    return 1
  }
  (( $# == 0 )) || {
    echo "ERROR: release-migrate does not accept transition exception arguments"
    return 1
  }
  if [[ "$action" != status ]]; then
    assert_mutation_drained
    # Only subsequent migrations are supported; the initial contract transition
    # is retired. Keep the applied receipt/schema assertion before any SQL deploy.
    run_release_entry dist-release/scripts/release-migrate.js assert-runtime phase2
  fi
  run_release_entry dist-release/scripts/release-migrate.js "$action" "$@"
}

do_release_assert() {
  local phase="${1:-}"
  [[ "$phase" == phase2 ]] || {
    echo "ERROR: release-assert requires phase2"
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
  load_env
  require_immutable_release_images
  load_runtime_env
  assert_quadlet_adopted
  rm -f "${CUTOVER_STATE_DIR}/mutation-drained"
  stop_application_units
  systemctl --user stop "$PG_UNIT"
  systemctl --user stop "$POD_UNIT"
  echo "Down complete. Quadlet volume '$PG_VOLUME' preserved."
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
  require_immutable_release_images
  local release_schema_phase="${RELEASE_SCHEMA_PHASE:-}"
  [[ "$release_schema_phase" == phase2 ]] || {
    echo "ERROR: RELEASE_SCHEMA_PHASE must explicitly be phase2"
    return 1
  }
  load_runtime_env
  validate_production_boundaries
  validate_capacity_boundaries "${NAS_EXPORT_HOST_PATH:-/mnt/nas/pcu_storage/GraduationGame}"
  assert_quadlet_adopted
  validate_release_artifacts "$release_schema_phase"
  mkdir -p "$CUTOVER_STATE_DIR"
  # Installed topology was checked byte-for-byte except immutable app Image lines.
  # Render again into a private staging directory and replace only app definitions.
  local staging ctr
  staging="$(mktemp -d)"
  if ! bash "$QUADLET_HELPERS/render.sh" "$staging/next"; then rm -rf "$staging"; return 1; fi
  rm -f "${CUTOVER_STATE_DIR}/mutation-drained"
  if ! stop_application_units; then rm -rf "$staging"; return 1; fi
  for ctr in "${RUNTIME_CONTAINERS[@]}"; do
    if ! install -m 600 "$staging/next/$ctr.container" "$QUADLET_DIR/$ctr.container"; then rm -rf "$staging"; return 1; fi
  done
  rm -rf "$staging"
  systemctl --user daemon-reload
  # Never start/restart the pod or PostgreSQL: StartWithPod could bypass this gate.
  assert_foundation_active
  assert_postgres_running
  release_common_args
  podman run "${RELEASE_CONTAINER_ARGS[@]}" --entrypoint node "$MIGRATION_IMAGE" \
    dist-release/scripts/release-migrate.js assert-runtime "$release_schema_phase"
  assert_foundation_active
  systemctl --user start "${API_CONTAINER}.service"
  verify_running "$API_CONTAINER" "API"
  local api_elapsed=0 api_healthy=0
  while (( api_elapsed < HEALTHCHECK_TIMEOUT )); do
    if podman exec "$API_CONTAINER" wget -qO- http://localhost:4000/api/health 2>/dev/null | grep -q '"ok":true'; then
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
  for ctr in "${RUNTIME_CONTAINERS[@]:1}"; do
    assert_foundation_active
    systemctl --user start "${ctr}.service"
    verify_running "$ctr" "$ctr"
  done
  echo "Forward-only Quadlet deploy complete; PostgreSQL and pod were retained."
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
  release-migrate) shift; do_release_migration "$@" ;;
  release-assert) do_release_assert "${2:-}" ;;
  inventory) do_inventory_snapshot "${2:-}" ;;
  capacity-preflight) do_capacity_preflight ;;
  boundary-preflight) load_env; load_runtime_env; validate_production_boundaries ;;
  release-artifact-preflight) do_release_artifact_preflight "${2:-}" ;;
  verify-final-web) do_verify_final_web "${2:-}" ;;
  # Restart uses the same gated application-only release transaction.
  restart) do_up ;;
  logs)    do_logs "${2:-api}" ;;
  status)  do_status ;;
  *)
    echo "Usage: $0 {up|down|drain|backup [label]|release-migrate [status|apply-contract]|release-assert phase2|inventory [/release-state/file]|capacity-preflight|boundary-preflight|release-artifact-preflight phase2|verify-final-web <git-sha>|restart|logs [api|pg|game|webgl|video|image|export]|status}"
    exit 1
    ;;
esac
