#!/bin/sh
# Garage initialization script for local development.
# Runs once after Garage is healthy to set up layout, buckets, keys and CORS.
set -eu

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
$GARAGE bucket website --allow pcu-public >/dev/null

echo "=== Garage init: creating access key and exact-origin CORS ==="
# Command substitution deliberately prevents Garage's key output (including
# its secret) from entering Compose logs.
if $GARAGE key info pcu-dev-key >/dev/null 2>&1; then
  KEY_OUTPUT=$($GARAGE key info --show-secret pcu-dev-key 2>/dev/null)
else
  KEY_OUTPUT=$($GARAGE key create pcu-dev-key 2>/dev/null)
fi
ACCESS_KEY_ID=$(printf '%s\n' "$KEY_OUTPUT" | sed -n 's/^Key ID: //p')
SECRET_ACCESS_KEY=$(printf '%s\n' "$KEY_OUTPUT" | sed -n 's/^Secret key: //p')
if [ -z "$ACCESS_KEY_ID" ] || [ -z "$SECRET_ACCESS_KEY" ]; then
  echo "Could not obtain the local credential for CORS initialization" >&2
  exit 1
fi

echo "=== Garage init: granting bucket permissions ==="
$GARAGE bucket allow pcu-public --read --write --owner --key pcu-dev-key >/dev/null 2>&1 || true
$GARAGE bucket allow pcu-protected --read --write --owner --key pcu-dev-key >/dev/null 2>&1 || true

S3_INTERNAL_ENDPOINT="${S3_INTERNAL_ENDPOINT:-http://garage:3900}" \
S3_CORS_ALLOWED_ORIGINS="${S3_CORS_ALLOWED_ORIGINS:-http://localhost:5173}" \
S3_ACCESS_KEY_ID="$ACCESS_KEY_ID" \
S3_SECRET_ACCESS_KEY="$SECRET_ACCESS_KEY" \
S3_REGION="${S3_REGION:-garage}" \
/usr/local/bin/garage-configure-cors protected pcu-protected
S3_INTERNAL_ENDPOINT="${S3_INTERNAL_ENDPOINT:-http://garage:3900}" \
S3_CORS_ALLOWED_ORIGINS="${S3_CORS_ALLOWED_ORIGINS:-http://localhost:5173}" \
S3_ACCESS_KEY_ID="$ACCESS_KEY_ID" \
S3_SECRET_ACCESS_KEY="$SECRET_ACCESS_KEY" \
S3_REGION="${S3_REGION:-garage}" \
/usr/local/bin/garage-configure-cors public pcu-public

echo "=== Garage init: done ==="
echo ""
echo "Store the local key through an approved local secret workflow; this init job never prints it."
