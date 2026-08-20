#!/usr/bin/env bash
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/srv/graduationproject_v2}"
ENV_FILE="${DEPLOY_DIR}/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo '{"action":"incomplete_multipart_cleanup","result":"configuration_error"}'
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

garage_config="${GARAGE_MAINTENANCE_CONFIG_HOST_PATH:?GARAGE_MAINTENANCE_CONFIG_HOST_PATH is required}"
garage_image="${GARAGE_MAINTENANCE_IMAGE:-dxflrs/garage:v1.1.0}"
max_age="${INCOMPLETE_MULTIPART_MAX_AGE:-2d}"
protected_bucket="${S3_BUCKET_PROTECTED:-pcu-protected}"
staging_bucket="${S3_BUCKET_STAGING:-pcu-staging}"

# Garage CLI output is suppressed because an SDK/RPC failure can contain an
# internal locator. Only this fixed action/result event reaches the journal.
if podman run --rm --network host \
  -v "${garage_config}:/etc/garage.toml:ro,Z" \
  "$garage_image" /garage -c /etc/garage.toml \
  bucket cleanup-incomplete-uploads --older-than "$max_age" \
  "$protected_bucket" "$staging_bucket" >/dev/null 2>&1; then
  echo '{"action":"incomplete_multipart_cleanup","result":"completed"}'
else
  echo '{"action":"incomplete_multipart_cleanup","result":"failed"}'
  exit 1
fi
