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
VALIDATION_WORKER_CONTAINER="gp-validation-worker"
EXPORT_WORKER_CONTAINER="gp-export-worker"
UPLOAD_PART_PROXY_CONTAINER="gp-upload-part-origin"
PUBLIC_ORIGIN_CONTAINER="gp-public-origin"
PG_IMAGE="docker.io/library/postgres:16-alpine"
NGINX_IMAGE="docker.io/library/nginx:1.27-alpine"
API_IMAGE="${API_IMAGE:-ghcr.io/pcugame/pcu-graduationproject-v2-api:latest}"
PULL_API_IMAGE="${PULL_API_IMAGE:-true}"
PG_VOLUME="gp_pg_data"
API_BIND_HOST="${API_BIND_HOST:-127.0.0.1}"
HEALTHCHECK_TIMEOUT=90  # seconds
UPLOAD_PART_INTERNAL_PORT=4081
PUBLIC_ORIGIN_INTERNAL_PORT=4082
UPLOAD_PART_TEMPLATE="${DEPLOY_DIR}/upload-part.nginx.conf.template"
PUBLIC_ORIGIN_TEMPLATE="${DEPLOY_DIR}/public-origin.nginx.conf.template"
GARAGE_CLEANUP_SCRIPT="${DEPLOY_DIR}/garage-incomplete-upload-cleanup.sh"
CUTOVER_MIGRATION="20260820130000_remove_legacy_game_upload_proxy"
TARGET_FENCE_MIGRATION="20260820150000_game_upload_expected_target_fence"

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

require_http_url() {
  local name="$1"
  local value="$2"
  if [[ ! "$value" =~ ^https?://[^/?#]+/?$ ]]; then
    echo "ERROR: $name must be an http(s) origin URL without path, query, or fragment"
    return 1
  fi
}

require_exact_origin() {
  local name="$1"
  local value="$2"
  require_http_url "$name" "$value"
  if [[ "$value" == *"*"* || "$value" == *","* ]]; then
    echo "ERROR: $name must contain exactly one origin and no wildcard"
    return 1
  fi
}

url_authority() {
  local value="${1#*://}"
  printf '%s' "${value%%/*}"
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

database_url_in_pod() {
  printf '%s' "${DATABASE_URL//\@postgres:/\@127.0.0.1:}"
}

database_has_migration() {
  local migration_name="$1"
  podman exec "$PG_CONTAINER" psql \
    -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -Atqc \
    "SELECT CASE WHEN to_regclass('_prisma_migrations') IS NOT NULL AND EXISTS (SELECT 1 FROM \"_prisma_migrations\" WHERE migration_name = '${migration_name}' AND finished_at IS NOT NULL AND rolled_back_at IS NULL) THEN 1 ELSE 0 END" \
    | grep -qx '1'
}

database_has_legacy_transport() {
  podman exec "$PG_CONTAINER" psql \
    -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -Atqc \
    "SELECT CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'game_upload_sessions' AND column_name = 'transport') THEN 1 ELSE 0 END" \
    | grep -qx '1'
}

run_candidate_migrations() {
  local db_url
  db_url=$(database_url_in_pod)
  podman run --rm \
    --network "container:${PG_CONTAINER}" \
    -e "DATABASE_URL=${db_url}" \
    "$API_IMAGE" npx prisma migrate deploy
}

# Breaking direct-only cutover gate. This command deliberately does not start
# any writer. It is safe to re-run: once the cutover migration is recorded the
# legacy audit is skipped, while backup and pending forward migrations remain
# explicit and durable.
do_cutover() {
  load_env

  if [[ "$PULL_API_IMAGE" == "true" ]]; then
    podman pull -q "$API_IMAGE"
  else
    podman image inspect "$API_IMAGE" >/dev/null
  fi
  podman container exists "$PG_CONTAINER" || {
    echo "ERROR: cutover requires the preserved PostgreSQL container; use a reviewed fresh bootstrap instead"
    return 1
  }

  echo "Draining old API and processing writers before cutover audit..."
  for ctr in "$VALIDATION_WORKER_CONTAINER" "$EXPORT_WORKER_CONTAINER" "$API_CONTAINER"; do
    podman stop "$ctr" --time 30 2>/dev/null || true
  done
  wait_for_pg

  if ! database_has_migration "$CUTOVER_MIGRATION" \
    || ! database_has_migration "$TARGET_FENCE_MIGRATION"; then
    if ! database_has_migration "$CUTOVER_MIGRATION"; then
      database_has_legacy_transport || {
      echo "ERROR: cutover migration is absent but the expected preserved legacy schema was not found"
      return 1
      }
    fi
    local db_url
    db_url=$(database_url_in_pod)
    echo "Running schema-aware read-only upload residue audit..."
    podman run --rm \
      --network "container:${PG_CONTAINER}" \
      -e "DATABASE_URL=${db_url}" \
      -e "S3_BUCKET_PUBLIC=${S3_BUCKET_PUBLIC:-pcu-public}" \
      -e "S3_BUCKET_PROTECTED=${S3_BUCKET_PROTECTED:-pcu-protected}" \
      "$API_IMAGE" npx tsx scripts/audit-game-upload-cutover.ts
  else
    echo "Cutover and target-fence cleanup migrations are already applied; destructive audit is not required."
  fi

  local backup_dir="${DEPLOY_DIR}/backups"
  local backup_file="${backup_dir}/pre-direct-cutover-$(date -u +%Y%m%dT%H%M%SZ).dump"
  umask 077
  mkdir -p "$backup_dir"
  echo "Creating preserved PostgreSQL backup at ${backup_file}"
  if ! podman exec "$PG_CONTAINER" sh -c \
    'exec pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$backup_file"; then
    rm -f "$backup_file"
    echo "ERROR: preserved database backup failed"
    return 1
  fi
  if [[ ! -s "$backup_file" ]] \
    || ! podman exec -i "$PG_CONTAINER" pg_restore -l < "$backup_file" >/dev/null 2>&1; then
    rm -f "$backup_file"
    echo "ERROR: preserved database backup is empty or unreadable"
    return 1
  fi

  echo "Applying candidate forward migrations after audit and backup..."
  run_candidate_migrations
  database_has_migration "$CUTOVER_MIGRATION" || {
    echo "ERROR: cutover migration did not reach the applied state"
    return 1
  }
  database_has_migration "$TARGET_FENCE_MIGRATION" || {
    echo "ERROR: target-fence cleanup migration did not reach the applied state"
    return 1
  }
  echo "Cutover gate complete. Deploy the candidate API and workers; do not restart an old image."
}

# ── Tear down ──────────────────────────────────────────────────
do_down() {
  echo "Stopping and removing containers..."

  # 1) Stop containers gracefully first, then force-remove
  for ctr in \
    "$VALIDATION_WORKER_CONTAINER" \
    "$EXPORT_WORKER_CONTAINER" \
    "$API_CONTAINER" \
    "$PUBLIC_ORIGIN_CONTAINER" \
    "$UPLOAD_PART_PROXY_CONTAINER" \
    "$PG_CONTAINER"; do
    podman stop "$ctr" --time 10 2>/dev/null || true
    podman rm -f "$ctr" 2>/dev/null || true
  done

  # 2) Stop and remove the pod (also removes its infra container)
  podman pod stop "$POD_NAME" --time 10 2>/dev/null || true
  podman pod rm -f "$POD_NAME" 2>/dev/null || true

  # 3) Verify nothing remains — if a container with our names still
  #    exists in any state (created/exited/dead), remove it by ID
  for ctr in \
    "$VALIDATION_WORKER_CONTAINER" \
    "$EXPORT_WORKER_CONTAINER" \
    "$API_CONTAINER" \
    "$PUBLIC_ORIGIN_CONTAINER" \
    "$UPLOAD_PART_PROXY_CONTAINER" \
    "$PG_CONTAINER"; do
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

verify_nginx_proxy() {
  local name="$1"
  local label="$2"
  local port="$3"
  verify_running "$name" "$label"
  podman exec "$name" nginx -t
  if podman exec "$name" grep -Eq '\$\{[A-Z_][A-Z_]*\}' /etc/nginx/conf.d/default.conf; then
    echo "ERROR: $label has unresolved template variables"
    return 1
  fi
  if ! podman exec "$name" wget -qO- "http://127.0.0.1:${port}/__pcu_proxy_health" >/dev/null; then
    echo "ERROR: $label health endpoint failed"
    podman logs "$name" --tail 30 2>/dev/null || true
    return 1
  fi
  echo "$label configuration and health check passed."
}

verify_public_upstream() {
  local public_host="$1"
  local response
  response=$(podman exec "$PUBLIC_ORIGIN_CONTAINER" wget -S -O /dev/null \
    --header="Host: ${public_host}" \
    "http://127.0.0.1:${PUBLIC_ORIGIN_INTERNAL_PORT}/__pcu_storage_probe_not_found" \
    2>&1 || true)
  if ! grep -q 'HTTP/' <<< "$response" || grep -Eq 'HTTP/[0-9.]+ (502|504)' <<< "$response"; then
    echo "ERROR: Public origin cannot reach the configured Garage website upstream"
    return 1
  fi
  echo "Public origin reached Garage website upstream without an application relay."
}

verify_upload_part_upstream() {
  local signing_host="$1"
  local origin="$2"
  local response
  response=$(podman exec "$UPLOAD_PART_PROXY_CONTAINER" sh -c '
    printf "OPTIONS /__pcu_storage_probe HTTP/1.1\r\nHost: %s\r\nOrigin: %s\r\nConnection: close\r\n\r\n" "$1" "$2" \
      | nc -w 5 127.0.0.1 "$3"
  ' sh "$signing_host" "$origin" "$UPLOAD_PART_INTERNAL_PORT" 2>&1 || true)
  if ! grep -q 'HTTP/' <<< "$response" || grep -Eq 'HTTP/[0-9.]+ (502|504)' <<< "$response"; then
    echo "ERROR: UploadPart origin cannot reach the configured Garage S3 upstream"
    return 1
  fi
  echo "UploadPart origin reached Garage S3 upstream with the browser Host preserved."
}

# ── Bring up ───────────────────────────────────────────────────
do_up() {
  load_env

  local nas_export_host_path="${NAS_EXPORT_HOST_PATH:-/mnt/nas/pcu_storage/GraduationGame}"
  local nas_export_container_path="${NAS_EXPORT_PATH:-/nas}"
  local upload_part_bind_host="${UPLOAD_PART_PROXY_BIND_HOST:-127.0.0.1}"
  local upload_part_port="${UPLOAD_PART_PROXY_PORT:-3901}"
  local public_origin_bind_host="${PUBLIC_ORIGIN_BIND_HOST:-127.0.0.1}"
  local public_origin_port="${PUBLIC_ORIGIN_PORT:-3904}"
  local garage_s3_upstream="${GARAGE_S3_UPSTREAM:-${S3_INTERNAL_ENDPOINT:-${S3_ENDPOINT:-}}}"
  local garage_public_web_upstream="${GARAGE_PUBLIC_WEB_UPSTREAM:-}"
  local upload_chunk_size_mb="${UPLOAD_CHUNK_SIZE_MB:-10}"
  local garage_maintenance_image="${GARAGE_MAINTENANCE_IMAGE:-dxflrs/garage:v1.1.0}"
  local incomplete_multipart_max_age="${INCOMPLETE_MULTIPART_MAX_AGE:-2d}"
  local incomplete_multipart_age_value
  local incomplete_multipart_age_unit
  local incomplete_multipart_age_seconds
  local upload_session_ttl_seconds
  local upload_part_max_bytes
  local public_asset_host
  local signing_host
  local api_public_host

  [[ -f "$UPLOAD_PART_TEMPLATE" ]] || {
    echo "ERROR: UploadPart nginx template not found at $UPLOAD_PART_TEMPLATE"
    return 1
  }
  [[ -f "$PUBLIC_ORIGIN_TEMPLATE" ]] || {
    echo "ERROR: public-origin nginx template not found at $PUBLIC_ORIGIN_TEMPLATE"
    return 1
  }
  [[ -x "$GARAGE_CLEANUP_SCRIPT" ]] || {
    echo "ERROR: Garage incomplete-upload cleanup script is missing or not executable at $GARAGE_CLEANUP_SCRIPT"
    return 1
  }
  [[ -r "${GARAGE_MAINTENANCE_CONFIG_HOST_PATH:?GARAGE_MAINTENANCE_CONFIG_HOST_PATH is required}" ]] || {
    echo "ERROR: Garage maintenance config is not readable"
    return 1
  }
  require_http_url "GARAGE_S3_UPSTREAM" "$garage_s3_upstream"
  require_http_url "GARAGE_PUBLIC_WEB_UPSTREAM" "$garage_public_web_upstream"
  require_http_url "S3_PUBLIC_SIGNING_ENDPOINT" "${S3_PUBLIC_SIGNING_ENDPOINT:?S3_PUBLIC_SIGNING_ENDPOINT is required}"
  require_http_url "PUBLIC_ASSET_BASE_URL" "${PUBLIC_ASSET_BASE_URL:?PUBLIC_ASSET_BASE_URL is required}"
  require_exact_origin "PUBLIC_CORS_ORIGIN_PRIMARY" "${PUBLIC_CORS_ORIGIN_PRIMARY:?PUBLIC_CORS_ORIGIN_PRIMARY is required}"
  require_exact_origin "PUBLIC_CORS_ORIGIN_SECONDARY" "${PUBLIC_CORS_ORIGIN_SECONDARY:?PUBLIC_CORS_ORIGIN_SECONDARY is required}"
  require_exact_origin "WEB_PUBLIC_ORIGIN" "${WEB_PUBLIC_ORIGIN:?WEB_PUBLIC_ORIGIN is required}"
  [[ "${PUBLIC_CORS_ORIGIN_PRIMARY}" != "${PUBLIC_CORS_ORIGIN_SECONDARY}" ]] || {
    echo "ERROR: public CORS origins must be distinct exact origins"
    return 1
  }
  [[ "$upload_chunk_size_mb" =~ ^[1-9][0-9]*$ ]] || {
    echo "ERROR: UPLOAD_CHUNK_SIZE_MB must be a positive integer"
    return 1
  }
  [[ "$incomplete_multipart_max_age" =~ ^([1-9][0-9]*)(h|d)$ ]] || {
    echo "ERROR: INCOMPLETE_MULTIPART_MAX_AGE must be a positive whole-hour or whole-day Garage duration"
    return 1
  }
  incomplete_multipart_age_value="${BASH_REMATCH[1]}"
  incomplete_multipart_age_unit="${BASH_REMATCH[2]}"
  if [[ "$incomplete_multipart_age_unit" == "d" ]]; then
    incomplete_multipart_age_seconds=$((incomplete_multipart_age_value * 86400))
  else
    incomplete_multipart_age_seconds=$((incomplete_multipart_age_value * 3600))
  fi
  [[ "${UPLOAD_SESSION_TTL_MINUTES:-1440}" =~ ^[1-9][0-9]*$ ]] || {
    echo "ERROR: UPLOAD_SESSION_TTL_MINUTES must be a positive integer"
    return 1
  }
  upload_session_ttl_seconds=$((${UPLOAD_SESSION_TTL_MINUTES:-1440} * 60))
  if (( incomplete_multipart_age_seconds <= upload_session_ttl_seconds )); then
    echo "ERROR: INCOMPLETE_MULTIPART_MAX_AGE must exceed UPLOAD_SESSION_TTL_MINUTES"
    return 1
  fi
  for bucket_name in "${S3_BUCKET_PROTECTED:-pcu-protected}" "${S3_BUCKET_STAGING:-pcu-staging}"; do
    [[ "$bucket_name" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || {
      echo "ERROR: Garage maintenance bucket names must be valid exact bucket names"
      return 1
    }
  done
  upload_part_max_bytes="${upload_chunk_size_mb}m"
  if [[ -n "${UPLOAD_PART_MAX_BYTES:-}" \
    && "${UPLOAD_PART_MAX_BYTES,,}" != "$upload_part_max_bytes" ]]; then
    echo "ERROR: UPLOAD_PART_MAX_BYTES must equal UPLOAD_CHUNK_SIZE_MB (${upload_part_max_bytes})"
    return 1
  fi
  public_asset_host=$(url_authority "$PUBLIC_ASSET_BASE_URL")
  signing_host=$(url_authority "$S3_PUBLIC_SIGNING_ENDPOINT")
  api_public_host=$(url_authority "${API_PUBLIC_URL:?API_PUBLIC_URL is required}")
  if [[ "$public_asset_host" == "$api_public_host" || "$signing_host" == "$api_public_host" ]]; then
    echo "ERROR: browser data-plane origins must not use the API host"
    return 1
  fi

  # Ensure volume exists
  podman volume inspect "$PG_VOLUME" &>/dev/null || podman volume create "$PG_VOLUME"

  # Pull latest images (-q: suppress per-layer progress — it lands on
  # stderr and pollutes CI logs with noisy "err:" lines via ssh-action.
  # Real pull errors still surface via exit code and set -e.)
  echo "Pulling images..."
  podman pull -q "$PG_IMAGE"
  podman pull -q "$NGINX_IMAGE"
  podman pull -q "$garage_maintenance_image"
  podman run --rm "$garage_maintenance_image" /garage \
    bucket cleanup-incomplete-uploads --help >/dev/null
  if [[ "$PULL_API_IMAGE" == "true" ]]; then
    podman pull -q "$API_IMAGE"
  else
    podman image inspect "$API_IMAGE" >/dev/null
    echo "Using existing local API image: $API_IMAGE"
  fi

  # Remove old containers/pod if they exist
  do_down

  # Small pause to let podman fully release resources
  sleep 2

  # Create pod with API port published only on loopback by default.
  # Public traffic should reach the API through the reverse proxy, not :4000.
  echo "Creating pod '$POD_NAME'..."
  podman pod create \
    --name "$POD_NAME" \
    -p "${API_BIND_HOST}:${API_PORT:-4000}:4000" \
    -p "${upload_part_bind_host}:${upload_part_port}:${UPLOAD_PART_INTERNAL_PORT}" \
    -p "${public_origin_bind_host}:${public_origin_port}:${PUBLIC_ORIGIN_INTERNAL_PORT}"

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

  # Container startup never performs implicit migrations. Fresh databases and
  # already-cut-over schemas may apply pending forward migrations here. A
  # preserved legacy schema is fail-closed until `deploy.sh cutover` completes
  # its drain/audit/backup gate.
  if database_has_legacy_transport; then
    echo "ERROR: preserved legacy schema requires './deploy.sh cutover' before starting writers"
    return 1
  fi
  if database_has_migration "$CUTOVER_MIGRATION" \
    && ! database_has_migration "$TARGET_FENCE_MIGRATION"; then
    echo "ERROR: preserved pre-fence direct sessions require './deploy.sh cutover' before starting writers"
    return 1
  fi
  run_candidate_migrations

  # These are ordinary transport proxies in the same production pod, not
  # application processes. The UploadPart proxy buffers and rejects oversized
  # bodies before Garage; the public proxy preserves byte/range validators.
  echo "Starting UploadPart transport origin..."
  podman run -d \
    --pod "$POD_NAME" \
    --name "$UPLOAD_PART_PROXY_CONTAINER" \
    --restart unless-stopped \
    -e "NGINX_ENTRYPOINT_QUIET_LOGS=1" \
    -e 'NGINX_ENVSUBST_FILTER=^(NGINX_LISTEN_PORT|UPLOAD_PART_MAX_BYTES|GARAGE_S3_UPSTREAM|GARAGE_S3_TLS_SERVER_NAME)$' \
    -e "NGINX_LISTEN_PORT=${UPLOAD_PART_INTERNAL_PORT}" \
    -e "UPLOAD_PART_MAX_BYTES=${upload_part_max_bytes}" \
    -e "GARAGE_S3_UPSTREAM=${garage_s3_upstream%/}" \
    -e "GARAGE_S3_TLS_SERVER_NAME=${GARAGE_S3_TLS_SERVER_NAME:?GARAGE_S3_TLS_SERVER_NAME is required}" \
    -v "${UPLOAD_PART_TEMPLATE}:/etc/nginx/templates/default.conf.template:ro,Z" \
    "$NGINX_IMAGE"

  echo "Starting public asset transport origin..."
  podman run -d \
    --pod "$POD_NAME" \
    --name "$PUBLIC_ORIGIN_CONTAINER" \
    --restart unless-stopped \
    -e "NGINX_ENTRYPOINT_QUIET_LOGS=1" \
    -e 'NGINX_ENVSUBST_FILTER=^(NGINX_LISTEN_PORT|GARAGE_PUBLIC_WEB_UPSTREAM|GARAGE_PUBLIC_WEB_TLS_SERVER_NAME|PUBLIC_CORS_ORIGIN_PRIMARY|PUBLIC_CORS_ORIGIN_SECONDARY|WEB_PUBLIC_ORIGIN)$' \
    -e "NGINX_LISTEN_PORT=${PUBLIC_ORIGIN_INTERNAL_PORT}" \
    -e "GARAGE_PUBLIC_WEB_UPSTREAM=${garage_public_web_upstream%/}" \
    -e "GARAGE_PUBLIC_WEB_TLS_SERVER_NAME=${GARAGE_PUBLIC_WEB_TLS_SERVER_NAME:?GARAGE_PUBLIC_WEB_TLS_SERVER_NAME is required}" \
    -e "PUBLIC_CORS_ORIGIN_PRIMARY=${PUBLIC_CORS_ORIGIN_PRIMARY}" \
    -e "PUBLIC_CORS_ORIGIN_SECONDARY=${PUBLIC_CORS_ORIGIN_SECONDARY}" \
    -e "WEB_PUBLIC_ORIGIN=${WEB_PUBLIC_ORIGIN}" \
    -v "${PUBLIC_ORIGIN_TEMPLATE}:/etc/nginx/templates/default.conf.template:ro,Z" \
    "$NGINX_IMAGE"

  verify_nginx_proxy \
    "$UPLOAD_PART_PROXY_CONTAINER" \
    "UploadPart transport origin" \
    "$UPLOAD_PART_INTERNAL_PORT"
  verify_nginx_proxy \
    "$PUBLIC_ORIGIN_CONTAINER" \
    "Public asset transport origin" \
    "$PUBLIC_ORIGIN_INTERNAL_PORT"
  verify_upload_part_upstream "$signing_host" "$PUBLIC_CORS_ORIGIN_PRIMARY"
  verify_public_upstream "$public_asset_host"

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
    -e "CORS_ALLOWED_ORIGINS=${CORS_ALLOWED_ORIGINS}" \
    -e "API_PUBLIC_URL=${API_PUBLIC_URL}" \
    -e "WEB_PUBLIC_URL=${WEB_PUBLIC_URL}" \
    -e "PUBLIC_ASSET_BASE_URL=${PUBLIC_ASSET_BASE_URL:?PUBLIC_ASSET_BASE_URL is required}" \
    -e "UPLOAD_ROOT_PROTECTED=/app/storage/protected" \
    -e "UPLOAD_ROOT_PUBLIC=/app/storage/public" \
    -e "LOG_LEVEL=${LOG_LEVEL:-info}" \
	-e "S3_INTERNAL_ENDPOINT=${S3_INTERNAL_ENDPOINT:-${S3_ENDPOINT:?S3_INTERNAL_ENDPOINT or deprecated S3_ENDPOINT is required}}" \
	-e "S3_PUBLIC_SIGNING_ENDPOINT=${S3_PUBLIC_SIGNING_ENDPOINT:-${S3_ENDPOINT:?S3_PUBLIC_SIGNING_ENDPOINT or deprecated S3_ENDPOINT is required}}" \
	-e "S3_ENDPOINT=${S3_ENDPOINT:-${S3_INTERNAL_ENDPOINT:?S3_INTERNAL_ENDPOINT is required}}" \
    -e "S3_REGION=${S3_REGION:-us-east-1}" \
    -e "S3_ACCESS_KEY_ID=${S3_ACCESS_KEY_ID}" \
    -e "S3_SECRET_ACCESS_KEY=${S3_SECRET_ACCESS_KEY}" \
    -e "S3_BUCKET_PUBLIC=${S3_BUCKET_PUBLIC:-pcu-public}" \
    -e "S3_BUCKET_PROTECTED=${S3_BUCKET_PROTECTED:-pcu-protected}" \
	-e "S3_BUCKET_STAGING=${S3_BUCKET_STAGING:-pcu-staging}" \
    -e "S3_FORCE_PATH_STYLE=${S3_FORCE_PATH_STYLE:-true}" \
	-e "S3_PRESIGN_TTL_SEC=${S3_PRESIGN_TTL_SEC:-60}" \
	-e "UPLOAD_PART_URL_TTL_SEC=${UPLOAD_PART_URL_TTL_SEC:-300}" \
	-e "UPLOAD_PART_URL_BATCH_MAX=${UPLOAD_PART_URL_BATCH_MAX:-16}" \
	-e "UPLOAD_CHUNK_SIZE_MB=${upload_chunk_size_mb}" \
	-e "INLINE_UPLOAD_MAX_BYTES=${INLINE_UPLOAD_MAX_BYTES:-16777216}" \
	-e "UPLOAD_PART_URL_REFRESH_MAX=${UPLOAD_PART_URL_REFRESH_MAX:-64}" \
	-e "UPLOAD_PART_URL_REFRESH_WINDOW_MS=${UPLOAD_PART_URL_REFRESH_WINDOW_MS:-300000}" \
	-e "DIRECT_UPLOAD_ACTOR_ACTIVE_SESSION_MAX=${DIRECT_UPLOAD_ACTOR_ACTIVE_SESSION_MAX:-4}" \
	-e "DIRECT_UPLOAD_PROJECT_ACTIVE_SESSION_MAX=${DIRECT_UPLOAD_PROJECT_ACTIVE_SESSION_MAX:-2}" \
	-e "DIRECT_UPLOAD_ACTOR_OUTSTANDING_MAX_BYTES=${DIRECT_UPLOAD_ACTOR_OUTSTANDING_MAX_BYTES:-10737418240}" \
	-e "RATE_LIMIT_DIRECT_SESSION_CREATE_MAX=${RATE_LIMIT_DIRECT_SESSION_CREATE_MAX:-12}" \
	-e "RATE_LIMIT_DIRECT_SESSION_CREATE_WINDOW_MS=${RATE_LIMIT_DIRECT_SESSION_CREATE_WINDOW_MS:-3600000}" \
	-e "RATE_LIMIT_DIRECT_PART_URL_MAX=${RATE_LIMIT_DIRECT_PART_URL_MAX:-120}" \
	-e "RATE_LIMIT_DIRECT_PART_URL_WINDOW_MS=${RATE_LIMIT_DIRECT_PART_URL_WINDOW_MS:-60000}" \
    -v "${STORAGE_HOST_PATH}/protected:/app/storage/protected:Z" \
    -v "${STORAGE_HOST_PATH}/public:/app/storage/public:Z" \
    "$API_IMAGE"

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

  # Validation is a processing data plane with an independent lifecycle and
  # resource ceiling. It starts only after the API migration/health gate and
  # never shares Fastify's process.
  echo "Starting validation worker..."
  podman run -d \
    --pod "$POD_NAME" \
    --name "$VALIDATION_WORKER_CONTAINER" \
    --restart unless-stopped \
    --tmpfs "/tmp/pcu-validation:rw,size=${VALIDATION_WORKER_TEMP_DISK_BUDGET_BYTES:-12884901888},mode=0700,uid=1001,gid=1001" \
    -e "NODE_ENV=production" \
    -e "DATABASE_URL=${db_url}" \
    -e "SESSION_SECRET=${SESSION_SECRET}" \
    -e "GOOGLE_CLIENT_IDS=${GOOGLE_CLIENT_IDS}" \
    -e "CORS_ALLOWED_ORIGINS=${CORS_ALLOWED_ORIGINS}" \
    -e "API_PUBLIC_URL=${API_PUBLIC_URL}" \
    -e "WEB_PUBLIC_URL=${WEB_PUBLIC_URL}" \
    -e "PUBLIC_ASSET_BASE_URL=${PUBLIC_ASSET_BASE_URL}" \
    -e "LOG_LEVEL=${LOG_LEVEL:-info}" \
    -e "S3_INTERNAL_ENDPOINT=${S3_INTERNAL_ENDPOINT:-${S3_ENDPOINT:?S3_INTERNAL_ENDPOINT or deprecated S3_ENDPOINT is required}}" \
    -e "S3_PUBLIC_SIGNING_ENDPOINT=${S3_PUBLIC_SIGNING_ENDPOINT:-${S3_ENDPOINT:?S3_PUBLIC_SIGNING_ENDPOINT or deprecated S3_ENDPOINT is required}}" \
    -e "S3_ENDPOINT=${S3_ENDPOINT:-${S3_INTERNAL_ENDPOINT:?S3_INTERNAL_ENDPOINT is required}}" \
    -e "S3_REGION=${S3_REGION:-us-east-1}" \
    -e "S3_ACCESS_KEY_ID=${VALIDATION_S3_ACCESS_KEY_ID:-${S3_ACCESS_KEY_ID}}" \
    -e "S3_SECRET_ACCESS_KEY=${VALIDATION_S3_SECRET_ACCESS_KEY:-${S3_SECRET_ACCESS_KEY}}" \
    -e "S3_BUCKET_PUBLIC=${S3_BUCKET_PUBLIC:-pcu-public}" \
    -e "S3_BUCKET_PROTECTED=${S3_BUCKET_PROTECTED:-pcu-protected}" \
    -e "S3_BUCKET_STAGING=${S3_BUCKET_STAGING:-pcu-staging}" \
    -e "S3_FORCE_PATH_STYLE=${S3_FORCE_PATH_STYLE:-true}" \
    -e "S3_PRESIGN_TTL_SEC=${S3_PRESIGN_TTL_SEC:-60}" \
    -e "VALIDATION_WORKER_CONCURRENCY=${VALIDATION_WORKER_CONCURRENCY:-2}" \
    -e "VALIDATION_WORKER_POLL_MS=${VALIDATION_WORKER_POLL_MS:-5000}" \
    -e "VALIDATION_WORKER_TEMP_ROOT=/tmp/pcu-validation" \
    -e "VALIDATION_WORKER_TEMP_DISK_BUDGET_BYTES=${VALIDATION_WORKER_TEMP_DISK_BUDGET_BYTES:-12884901888}" \
    -e "VALIDATION_WORKER_CLAIM_LEASE_MS=${VALIDATION_WORKER_CLAIM_LEASE_MS:-600000}" \
    "$API_IMAGE" node dist/validation-worker.js

  verify_running "$VALIDATION_WORKER_CONTAINER" "Validation worker"

  echo "Starting durable NAS export worker..."
  podman run -d \
    --pod "$POD_NAME" \
    --name "$EXPORT_WORKER_CONTAINER" \
    --restart unless-stopped \
    -e "NODE_ENV=production" \
    -e "DATABASE_URL=${db_url}" \
    -e "SESSION_SECRET=${SESSION_SECRET}" \
    -e "GOOGLE_CLIENT_IDS=${GOOGLE_CLIENT_IDS}" \
    -e "CORS_ALLOWED_ORIGINS=${CORS_ALLOWED_ORIGINS}" \
    -e "API_PUBLIC_URL=${API_PUBLIC_URL}" \
    -e "WEB_PUBLIC_URL=${WEB_PUBLIC_URL}" \
    -e "PUBLIC_ASSET_BASE_URL=${PUBLIC_ASSET_BASE_URL}" \
    -e "LOG_LEVEL=${LOG_LEVEL:-info}" \
    -e "S3_INTERNAL_ENDPOINT=${S3_INTERNAL_ENDPOINT:-${S3_ENDPOINT:?S3_INTERNAL_ENDPOINT is required}}" \
    -e "S3_PUBLIC_SIGNING_ENDPOINT=${S3_PUBLIC_SIGNING_ENDPOINT:-${S3_ENDPOINT:?S3_PUBLIC_SIGNING_ENDPOINT is required}}" \
    -e "S3_ENDPOINT=${S3_ENDPOINT:-${S3_INTERNAL_ENDPOINT:?S3_INTERNAL_ENDPOINT is required}}" \
    -e "S3_REGION=${S3_REGION:-us-east-1}" \
    -e "S3_ACCESS_KEY_ID=${EXPORT_S3_ACCESS_KEY_ID:-${S3_ACCESS_KEY_ID}}" \
    -e "S3_SECRET_ACCESS_KEY=${EXPORT_S3_SECRET_ACCESS_KEY:-${S3_SECRET_ACCESS_KEY}}" \
    -e "S3_BUCKET_PUBLIC=${S3_BUCKET_PUBLIC:-pcu-public}" \
    -e "S3_BUCKET_PROTECTED=${S3_BUCKET_PROTECTED:-pcu-protected}" \
    -e "S3_BUCKET_STAGING=${S3_BUCKET_STAGING:-pcu-staging}" \
    -e "S3_FORCE_PATH_STYLE=${S3_FORCE_PATH_STYLE:-true}" \
    -e "S3_PRESIGN_TTL_SEC=${S3_PRESIGN_TTL_SEC:-60}" \
    -e "NAS_EXPORT_PATH=${nas_export_container_path}" \
    -e "EXPORT_WORKER_CONCURRENCY=${EXPORT_WORKER_CONCURRENCY:-1}" \
    -e "EXPORT_WORKER_POLL_MS=${EXPORT_WORKER_POLL_MS:-5000}" \
    -e "EXPORT_WORKER_CLAIM_LEASE_MS=${EXPORT_WORKER_CLAIM_LEASE_MS:-600000}" \
    -v "${nas_export_host_path}:${nas_export_container_path}:rw" \
    "$API_IMAGE" node dist/export-worker.js

  verify_running "$EXPORT_WORKER_CONTAINER" "Export worker"

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

  # Age-based Garage safety net. It runs outside API/worker lifecycles and
  # never replaces exact durable abort tasks committed by business mutations.
  local cleanup_service="$systemd_dir/garage-incomplete-upload-cleanup.service"
  local cleanup_timer="$systemd_dir/garage-incomplete-upload-cleanup.timer"
  cat > "$cleanup_service" <<EOF
[Unit]
Description=Abort aged Garage incomplete multipart uploads
After=network-online.target

[Service]
Type=oneshot
Environment=DEPLOY_DIR=${DEPLOY_DIR}
ExecStart=${GARAGE_CLEANUP_SCRIPT}
EOF
  cat > "$cleanup_timer" <<'EOF'
[Unit]
Description=Schedule Garage incomplete multipart cleanup

[Timer]
OnBootSec=15min
OnUnitActiveSec=6h
RandomizedDelaySec=15min
Persistent=true
Unit=garage-incomplete-upload-cleanup.service

[Install]
WantedBy=timers.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now garage-incomplete-upload-cleanup.timer
  echo "Garage incomplete multipart cleanup timer enabled."

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
    worker|validation) podman logs -f "$VALIDATION_WORKER_CONTAINER" ;;
    export|export-worker) podman logs -f "$EXPORT_WORKER_CONTAINER" ;;
    upload|upload-part) podman logs -f "$UPLOAD_PART_PROXY_CONTAINER" ;;
    public|public-origin) podman logs -f "$PUBLIC_ORIGIN_CONTAINER" ;;
    pg|postgres|db) podman logs -f "$PG_CONTAINER" ;;
    *) echo "Usage: $0 logs [api|worker|export-worker|upload-part|public-origin|pg]" ;;
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
  echo ""
  echo "=== Transport proxy config ==="
  for ctr in "$UPLOAD_PART_PROXY_CONTAINER" "$PUBLIC_ORIGIN_CONTAINER"; do
    if podman container exists "$ctr" 2>/dev/null; then
      podman exec "$ctr" nginx -t 2>&1 || true
    else
      echo "$ctr: missing"
    fi
  done
}

# ── Main ───────────────────────────────────────────────────────
case "${1:-up}" in
  up)      do_up ;;
  cutover) do_cutover ;;
  down)    do_down ;;
  restart) do_down; do_up ;;
  logs)    do_logs "${2:-api}" ;;
  status)  do_status ;;
  *)
    echo "Usage: $0 {cutover|up|down|restart|logs [api|worker|export-worker|upload-part|public-origin|pg]|status}"
    exit 1
    ;;
esac
