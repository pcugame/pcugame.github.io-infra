# shellcheck shell=bash
# Source-only module: loaded by deploy.sh in its shared release context.

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

do_activation_preflight() {
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
}

