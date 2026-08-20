#!/bin/sh
# Garage initialization script for local development.
# Runs once after Garage is healthy to set up layout, buckets, and access keys.
set -e

GARAGE="garage -c /etc/garage.toml"

echo "=== Garage init: configuring layout ==="
NODE_ID=$($GARAGE status 2>/dev/null | awk '/^[0-9a-f]/ { print $1; exit }')
if [ -z "$NODE_ID" ]; then
  echo "Could not discover the Garage node ID" >&2
  exit 1
fi
$GARAGE layout assign "$NODE_ID" -z dc1 -c 1G 2>/dev/null || true
$GARAGE layout apply --version 1 2>/dev/null || echo "Layout already applied"

echo "=== Garage init: creating buckets ==="
$GARAGE bucket create pcu-public 2>/dev/null || echo "Bucket pcu-public already exists"
$GARAGE bucket create pcu-protected 2>/dev/null || echo "Bucket pcu-protected already exists"
$GARAGE bucket create pcu-staging 2>/dev/null || echo "Bucket pcu-staging already exists"

echo "=== Garage init: creating local credential ==="
# Create key and extract credentials
KEY_OUTPUT=$($GARAGE key create pcu-dev-key 2>/dev/null || $GARAGE key info --show-secret pcu-dev-key 2>/dev/null)
ACCESS_KEY_ID=$(printf '%s\n' "$KEY_OUTPUT" | sed -n 's/^Key ID: //p')
SECRET_ACCESS_KEY=$(printf '%s\n' "$KEY_OUTPUT" | sed -n 's/^Secret key: //p')
if [ -z "$ACCESS_KEY_ID" ] || [ -z "$SECRET_ACCESS_KEY" ]; then
  echo "Could not extract local Garage credentials for CORS initialization" >&2
  exit 1
fi

echo "=== Garage init: granting bucket permissions ==="
$GARAGE bucket allow pcu-public --read --write --owner --key pcu-dev-key >/dev/null 2>&1 || true
$GARAGE bucket allow pcu-protected --read --write --owner --key pcu-dev-key >/dev/null 2>&1 || true
$GARAGE bucket allow pcu-staging --read --write --owner --key pcu-dev-key >/dev/null 2>&1 || true

# Garage v1.1 implements standard PutBucketCors/GetBucketCors. Configure the
# two untrusted-upload targets through that data-plane API and fail fast if the
# pinned server stops supporting it.
S3_INTERNAL_ENDPOINT="${S3_INTERNAL_ENDPOINT:-${S3_ENDPOINT:-http://garage:3900}}" \
S3_CORS_ALLOWED_ORIGINS="${S3_CORS_ALLOWED_ORIGINS:-http://localhost:5173}" \
S3_ACCESS_KEY_ID="$ACCESS_KEY_ID" \
S3_SECRET_ACCESS_KEY="$SECRET_ACCESS_KEY" \
S3_REGION="${S3_REGION:-garage}" \
/bin/sh /garage-configure-cors.sh pcu-staging pcu-protected

echo "=== Garage init: done ==="
echo ""
echo "Use the Garage admin console or an approved secret-management workflow to retrieve local credentials."
