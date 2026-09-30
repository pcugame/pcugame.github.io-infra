#!/bin/sh
# Opt-in real API + PostgreSQL + Garage + Nginx verification, never production.
# Read gateways require canonical ownership and live sessions; a standalone
# Garage fixture cannot exercise their authorization boundary.
set -eu

if [ "${LIVE_GARAGE_PROXY_TEST:-0}" != 1 ]; then
  echo "SKIP live Garage proxy test (set LIVE_GARAGE_PROXY_TEST=1)"
  exit 0
fi

command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm is required" >&2; exit 1; }
base_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$base_dir/../.." && pwd)
# Fresh named volumes avoid any existing migration observation history. The
# documented integration host ports must be free before starting this test.
export COMPOSE_PROJECT_NAME="pcu-gateway-live-$$"
cleanup() {
  docker compose -f "$repo_dir/docker-compose.integration.yml" down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
cd "$repo_dir"
npm run test:integration
