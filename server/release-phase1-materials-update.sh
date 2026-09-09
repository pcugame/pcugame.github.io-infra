#!/usr/bin/env bash
# Additive materials runtime update. Data correction is a separate reviewed command.
set -euo pipefail
DEPLOY_DIR="${DEPLOY_DIR:-/srv/graduationproject_v2}"
release_image="${1:?immutable image digest required}"
release_revision="${2:?exact source revision required}"
[[ "$release_image" =~ ^ghcr\.io/pcugame/pcu-graduationproject-v2-api@sha256:[0-9a-f]{64}$ ]]
[[ "$release_revision" =~ ^[0-9a-f]{40}$ ]]
set -a
source "${DEPLOY_DIR}/.env"
set +a
[[ "${API_IMAGE:-$release_image}" == "$release_image" ]]
[[ "${MIGRATION_IMAGE:-$release_image}" == "$release_image" ]]
[[ "${RELEASE_SOURCE_SHA:-$release_revision}" == "$release_revision" ]]
[[ "${RELEASE_SCHEMA_PHASE:-phase1}" == phase1 ]]
[[ "${START_DEDICATED_WORKERS:-true}" == true ]]
export API_IMAGE="$release_image" MIGRATION_IMAGE="$release_image" RELEASE_SOURCE_SHA="$release_revision"
export RELEASE_SCHEMA_PHASE=phase1 START_DEDICATED_WORKERS=true
export CUTOVER_STATE_DIR="${CUTOVER_STATE_DIR:-${DEPLOY_DIR}/cutover-state}"
control="${DEPLOY_DIR}/deploy.sh"
query() {
  podman exec -i gp-postgres sh -c 'exec psql -X -qAt --set ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
}
"$control" release-artifact-preflight phase1
"$control" capacity-preflight
podman run --rm --entrypoint node "$API_IMAGE" -e '
  const fs = require("node:fs");
  const migrations = fs.readdirSync("prisma/migrations").filter(x => fs.statSync(`prisma/migrations/${x}`).isDirectory()).sort();
  if (migrations.at(-1) !== "20260821910000_project_material_constraints_expand") throw new Error("unexpected Phase 1 migration ceiling");
  for (const file of ["dist-release/scripts/correct-canonical-assets.js", "dist-release/scripts/correct-canonical-poster.js"]) {
    if (!fs.existsSync(file)) throw new Error("missing compiled correction entry: " + file);
  }
'
state="$(query <<'SQL'
SELECT count(*) FILTER (WHERE migration_name = '20260821800000_project_video_order_expand' AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  || '|' || count(*) FILTER (WHERE migration_name = '20260822000000_canonical_asset_contract')
  || '|' || count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
FROM "_prisma_migrations";
SQL
)"
[[ "$state" == '1|0|0' ]] || { echo "Existing ordered Phase 1 migration history required: $state"; exit 1; }
maintenance_started=false
cleanup() {
  local code=$?
  trap - EXIT INT TERM HUP
  if [[ "$maintenance_started" == true ]]; then
    "$control" drain || echo 'CRITICAL: could not confirm mutation drain' >&2
    echo 'Materials update failed; preserve additive schema and recover with a compatible runtime.' >&2
    [[ "$code" != 0 ]] || code=1
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
maintenance_started=true
"$control" drain
"$control" backup "materials-${RELEASE_SOURCE_SHA}"
audit_prefix="${CUTOVER_STATE_DIR}/materials-${RELEASE_SOURCE_SHA}-$(date -u +%Y%m%dT%H%M%SZ)"
"$control" inventory "/release-state/materials-before-${RELEASE_SOURCE_SHA}.json"
query > "${audit_prefix}.before.jsonl" <<'SQL'
SELECT row_to_json(a) FROM assets a ORDER BY id;
SQL
"$control" release-migrate apply-expand
"$control" release-assert phase1
query > "${audit_prefix}.after.jsonl" <<'SQL'
SELECT row_to_json(a) FROM assets a ORDER BY id;
SQL
cmp "${audit_prefix}.before.jsonl" "${audit_prefix}.after.jsonl"
"$control" up
"$control" release-assert phase1
podman exec gp-api node -e '
  fetch("http://127.0.0.1:4000/api/public/upload-config").then(async r => {
    const body = await r.json(); const config = body.data ?? body;
    if (!r.ok || config.materialMaxCount !== 5 || config.materialMaxBytes !== 52428800) throw new Error("materials capability check failed");
  }).catch(e => { console.error(e); process.exitCode = 1; });
' 
maintenance_started=false
trap - EXIT INT TERM HUP
printf 'Phase 1 materials runtime ready: %s; reviewed correction is still pending.\n' "$RELEASE_SOURCE_SHA"
