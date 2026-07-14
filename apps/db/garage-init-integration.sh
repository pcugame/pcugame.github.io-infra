#!/bin/sh
# Garage initialization for the Docker Compose integration environment.
set -e

GARAGE="garage -c /etc/garage.toml"
KEY_NAME="${GARAGE_KEY_NAME:-pcu-integration-key}"
ACCESS_KEY_ID="${S3_ACCESS_KEY_ID:?S3_ACCESS_KEY_ID is required}"
SECRET_ACCESS_KEY="${S3_SECRET_ACCESS_KEY:?S3_SECRET_ACCESS_KEY is required}"
PUBLIC_BUCKET="${S3_BUCKET_PUBLIC:-pcu-public}"
PROTECTED_BUCKET="${S3_BUCKET_PROTECTED:-pcu-protected}"

echo "=== Garage integration init: configuring layout ==="
NODE_ID=$($GARAGE status 2>/dev/null | awk '/^[0-9a-f]/ { print $1; exit }')
if [ -z "$NODE_ID" ]; then
  echo "Could not discover the Garage node ID" >&2
  exit 1
fi
$GARAGE layout assign "$NODE_ID" -z dc1 -c 1G 2>/dev/null || true
$GARAGE layout apply --version 1 2>/dev/null || echo "Layout already applied"

echo "=== Garage integration init: creating buckets ==="
$GARAGE bucket create "$PUBLIC_BUCKET" 2>/dev/null || echo "Bucket $PUBLIC_BUCKET already exists"
$GARAGE bucket create "$PROTECTED_BUCKET" 2>/dev/null || echo "Bucket $PROTECTED_BUCKET already exists"

echo "=== Garage integration init: creating deterministic access key ==="
if $GARAGE key info "$KEY_NAME" >/dev/null 2>&1; then
  echo "Key $KEY_NAME already exists"
elif $GARAGE key import --yes -n "$KEY_NAME" "$ACCESS_KEY_ID" "$SECRET_ACCESS_KEY" >/dev/null 2>&1; then
  echo "Imported key $KEY_NAME"
else
  echo "Could not import deterministic Garage key" >&2
  echo "Check the Garage CLI key import syntax for the pinned image." >&2
  exit 1
fi

echo "=== Garage integration init: granting bucket permissions ==="
$GARAGE bucket allow "$PUBLIC_BUCKET" --read --write --owner --key "$KEY_NAME" 2>/dev/null || true
$GARAGE bucket allow "$PROTECTED_BUCKET" --read --write --owner --key "$KEY_NAME" 2>/dev/null || true

echo "=== Garage integration init: done ==="
