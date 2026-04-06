#!/bin/sh
# Garage initialization script for local development.
# Runs once after Garage is healthy to set up layout, buckets, and access keys.
set -e

GARAGE="garage -c /etc/garage.toml"

echo "=== Garage init: configuring layout ==="
NODE_ID=$($GARAGE node id 2>/dev/null | head -1 | cut -d@ -f1)
$GARAGE layout assign "$NODE_ID" -z dc1 -c 1G 2>/dev/null || true
$GARAGE layout apply --version 1 2>/dev/null || echo "Layout already applied"

echo "=== Garage init: creating buckets ==="
$GARAGE bucket create pcu-public 2>/dev/null || echo "Bucket pcu-public already exists"
$GARAGE bucket create pcu-protected 2>/dev/null || echo "Bucket pcu-protected already exists"

echo "=== Garage init: creating access key ==="
# Create key and extract credentials
KEY_OUTPUT=$($GARAGE key create pcu-dev-key 2>/dev/null || $GARAGE key info pcu-dev-key 2>/dev/null)
echo "$KEY_OUTPUT"

echo "=== Garage init: granting bucket permissions ==="
$GARAGE bucket allow pcu-public --read --write --owner --key pcu-dev-key 2>/dev/null || true
$GARAGE bucket allow pcu-protected --read --write --owner --key pcu-dev-key 2>/dev/null || true

echo "=== Garage init: done ==="
echo ""
echo "Use 'docker compose exec garage garage -c /etc/garage.toml key info pcu-dev-key'"
echo "to retrieve the access key ID and secret key for your .env file."
