#!/usr/bin/env bash
# deploy.sh — podman-native deployment script (no docker-compose needed)
# Usage: ./deploy.sh [up|down|restart|logs|status]
# Requires: podman, .env file in the same directory as this script or DEPLOY_DIR env var
set -euo pipefail

# ── Configuration ──────────────────────────────────────────────
DEPLOY_DIR="${DEPLOY_DIR:-/srv/graduationproject_v2}"
ENV_FILE="${DEPLOY_DIR}/.env"
POD_NAME="graduationproject"
PG_CONTAINER="gp-postgres"
API_CONTAINER="gp-api"
PG_IMAGE="docker.io/library/postgres:16-alpine"
API_IMAGE="ghcr.io/pcugame/pcu-graduationproject-v2-api:latest"
PG_VOLUME="gp_pg_data"
HEALTHCHECK_TIMEOUT=60  # seconds

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

# ── Wait for PostgreSQL ────────────────────────────────────────
wait_for_pg() {
  echo "Waiting for PostgreSQL to be ready..."
  local elapsed=0
  while (( elapsed < HEALTHCHECK_TIMEOUT )); do
    if podman exec "$PG_CONTAINER" pg_isready -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" &>/dev/null; then
      echo "PostgreSQL is ready! (${elapsed}s)"
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  echo "ERROR: PostgreSQL did not become ready within ${HEALTHCHECK_TIMEOUT}s"
  podman logs "$PG_CONTAINER" --tail 30
  return 1
}

# ── Tear down ──────────────────────────────────────────────────
do_down() {
  echo "Stopping and removing containers..."
  podman rm -f "$API_CONTAINER" 2>/dev/null || true
  podman rm -f "$PG_CONTAINER" 2>/dev/null || true
  podman pod rm -f "$POD_NAME" 2>/dev/null || true
  echo "Down complete. (Volume '$PG_VOLUME' preserved)"
}

# ── Bring up ───────────────────────────────────────────────────
do_up() {
  load_env

  # Ensure volume exists
  podman volume inspect "$PG_VOLUME" &>/dev/null || podman volume create "$PG_VOLUME"

  # Pull latest images
  echo "Pulling images..."
  podman pull "$PG_IMAGE"
  podman pull "$API_IMAGE"

  # Remove old containers/pod if they exist
  do_down

  # Create pod with API port published
  echo "Creating pod '$POD_NAME'..."
  podman pod create \
    --name "$POD_NAME" \
    -p "${API_PORT:-4000}:4000"

  # Start PostgreSQL
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

  # Wait for PostgreSQL to be healthy
  wait_for_pg

  # Fix DATABASE_URL: in a pod, containers share localhost
  # Replace the hostname 'postgres' with '127.0.0.1' since they're in the same pod
  local db_url="${DATABASE_URL//\@postgres:/\@127.0.0.1:}"

  # Start API
  echo "Starting API..."
  podman run -d \
    --pod "$POD_NAME" \
    --name "$API_CONTAINER" \
    --restart unless-stopped \
    -e "NODE_ENV=production" \
    -e "PORT=4000" \
    -e "DATABASE_URL=${db_url}" \
    -e "SESSION_SECRET=${SESSION_SECRET}" \
    -e "SESSION_COOKIE_NAME=${SESSION_COOKIE_NAME:-sid}" \
    -e "SESSION_TTL_DAYS=${SESSION_TTL_DAYS:-7}" \
    -e "COOKIE_SECURE=${COOKIE_SECURE:-true}" \
    -e "COOKIE_SAME_SITE=${COOKIE_SAME_SITE:-none}" \
    -e "GOOGLE_CLIENT_IDS=${GOOGLE_CLIENT_IDS}" \
    -e "ALLOWED_GOOGLE_HD=${ALLOWED_GOOGLE_HD:-}" \
    -e "CORS_ALLOWED_ORIGINS=${CORS_ALLOWED_ORIGINS}" \
    -e "API_PUBLIC_URL=${API_PUBLIC_URL}" \
    -e "WEB_PUBLIC_URL=${WEB_PUBLIC_URL}" \
    -e "UPLOAD_ROOT_PROTECTED=/app/storage/protected" \
    -e "UPLOAD_ROOT_PUBLIC=/app/storage/public" \
    -e "AUTO_PUBLISH_DEFAULT=${AUTO_PUBLISH_DEFAULT:-false}" \
    -e "LOG_LEVEL=${LOG_LEVEL:-info}" \
    -v "${STORAGE_HOST_PATH}/protected:/app/storage/protected:Z" \
    -v "${STORAGE_HOST_PATH}/public:/app/storage/public:Z" \
    "$API_IMAGE"

  echo ""
  echo "=== Deploy complete ==="
  podman pod ps --filter "name=$POD_NAME"
  echo ""
  podman ps --pod --filter "pod=$POD_NAME"
}

# ── Logs ───────────────────────────────────────────────────────
do_logs() {
  local target="${1:-api}"
  case "$target" in
    api|app) podman logs -f "$API_CONTAINER" ;;
    pg|postgres|db) podman logs -f "$PG_CONTAINER" ;;
    *) echo "Usage: $0 logs [api|pg]" ;;
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
  restart) do_down; do_up ;;
  logs)    do_logs "${2:-api}" ;;
  status)  do_status ;;
  *)
    echo "Usage: $0 {up|down|restart|logs [api|pg]|status}"
    exit 1
    ;;
esac
