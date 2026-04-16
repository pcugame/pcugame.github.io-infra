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
HEALTHCHECK_TIMEOUT=90  # seconds

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
  for ctr in "$API_CONTAINER" "$PG_CONTAINER"; do
    podman stop "$ctr" --time 10 2>/dev/null || true
    podman rm -f "$ctr" 2>/dev/null || true
  done

  # 2) Stop and remove the pod (also removes its infra container)
  podman pod stop "$POD_NAME" --time 10 2>/dev/null || true
  podman pod rm -f "$POD_NAME" 2>/dev/null || true

  # 3) Verify nothing remains — if a container with our names still
  #    exists in any state (created/exited/dead), remove it by ID
  for ctr in "$API_CONTAINER" "$PG_CONTAINER"; do
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

  # Ensure volume exists
  podman volume inspect "$PG_VOLUME" &>/dev/null || podman volume create "$PG_VOLUME"

  # Pull latest images
  echo "Pulling images..."
  podman pull "$PG_IMAGE"
  podman pull "$API_IMAGE"

  # Remove old containers/pod if they exist
  do_down

  # Small pause to let podman fully release resources
  sleep 2

  # Create pod with API port published
  echo "Creating pod '$POD_NAME'..."
  podman pod create \
    --name "$POD_NAME" \
    -p "${API_PORT:-4000}:4000"

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

  # Fix DATABASE_URL: in a pod, containers share localhost
  # Replace the hostname 'postgres' with '127.0.0.1' since they're in the same pod
  local db_url="${DATABASE_URL//\@postgres:/\@127.0.0.1:}"

  # Start API (no --replace: we just ensured a clean state)
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
    -e "S3_ENDPOINT=${S3_ENDPOINT}" \
    -e "S3_REGION=${S3_REGION:-us-east-1}" \
    -e "S3_ACCESS_KEY_ID=${S3_ACCESS_KEY_ID}" \
    -e "S3_SECRET_ACCESS_KEY=${S3_SECRET_ACCESS_KEY}" \
    -e "S3_BUCKET_PUBLIC=${S3_BUCKET_PUBLIC:-pcu-public}" \
    -e "S3_BUCKET_PROTECTED=${S3_BUCKET_PROTECTED:-pcu-protected}" \
    -e "S3_FORCE_PATH_STYLE=${S3_FORCE_PATH_STYLE:-true}" \
    -v "${STORAGE_HOST_PATH}/protected:/app/storage/protected:Z" \
    -v "${STORAGE_HOST_PATH}/public:/app/storage/public:Z" \
    -v "/mnt/nas/pcu_storage/GraduationGame/Asset:/nas/Asset:ro" \
    "$API_IMAGE"

  # Verify API container is actually running
  verify_running "$API_CONTAINER" "API"

  # Wait for API health check (DB + storage)
  echo "Waiting for API health check..."
  local api_elapsed=0
  while (( api_elapsed < HEALTHCHECK_TIMEOUT )); do
    if podman exec "$API_CONTAINER" wget -qO- http://localhost:4000/api/health 2>/dev/null | grep -q '"ok":true'; then
      echo "API health check passed! (${api_elapsed}s)"
      break
    fi
    sleep 2
    api_elapsed=$((api_elapsed + 2))
  done
  if (( api_elapsed >= HEALTHCHECK_TIMEOUT )); then
    echo "WARNING: API health check did not pass within ${HEALTHCHECK_TIMEOUT}s"
    podman logs "$API_CONTAINER" --tail 30 2>/dev/null || true
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
