# shellcheck shell=bash
# Source-only module: loaded by deploy.sh in its shared release context.

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

QUADLET_HELPERS="${DEPLOY_SCRIPT_DIR}/quadlet"
POD_UNIT=graduationproject-pod.service
PG_UNIT=gp-postgres.service
APP_UNITS=()
for ctr in "${RUNTIME_CONTAINERS[@]}"; do APP_UNITS+=("${ctr}.service"); done

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

load_runtime_env() {
  APP_RUNTIME_ENV_FILE="${APP_RUNTIME_ENV_FILE:-${DEPLOY_DIR}/runtime-env/common.env}"
  API_RUNTIME_ENV_FILE="${API_RUNTIME_ENV_FILE:-${DEPLOY_DIR}/runtime-env/api.env}"
  POSTGRES_RUNTIME_ENV_FILE="${POSTGRES_RUNTIME_ENV_FILE:-${DEPLOY_DIR}/runtime-env/postgres.env}"
  local assignments
  assignments="$(python3 "$QUADLET_HELPERS/runtime-env.py" "$APP_RUNTIME_ENV_FILE" "$API_RUNTIME_ENV_FILE" "$POSTGRES_RUNTIME_ENV_FILE")" || return 1
  eval "$assignments"
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

