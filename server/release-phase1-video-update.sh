#!/usr/bin/env bash
# Additive update of an existing Phase 1 installation; no object backfill or contract.
set -euo pipefail
DEPLOY_DIR="${DEPLOY_DIR:-/srv/graduationproject_v2}"
release_image="${1:?immutable image digest required}"
release_revision="${2:?source revision required}"
release_publish_web="${3:-false}"
[[ "$release_publish_web" == true || "$release_publish_web" == false ]]
[[ "$release_image" =~ ^ghcr\.io/pcugame/pcu-graduationproject-v2-api@sha256:[0-9a-f]{64}$ ]]
[[ "$release_revision" =~ ^[0-9a-f]{40}$ ]]
set -a
source "${DEPLOY_DIR}/.env"
set +a
# deploy.sh re-sources this same configuration on every operation. Refuse a
# conflicting release setting rather than letting it retarget a later command.
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
  const names = fs.readdirSync("prisma/migrations").filter(x => fs.statSync(`prisma/migrations/${x}`).isDirectory()).sort();
  if (names.at(-1) !== "20260821800000_project_video_order_expand") throw new Error("unexpected Phase 1 migration ceiling");
'
# Fail before maintenance if this is not an already-expanded installation.
state="$(query <<'SQL'
SELECT count(*) FILTER (WHERE migration_name = '20260821700000_canonical_object_relocation_expand' AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  || '|' || count(*) FILTER (WHERE migration_name = '20260822000000_canonical_asset_contract')
  || '|' || count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
FROM "_prisma_migrations";
SQL
)"
[[ "$state" == '1|0|0' ]] || { echo "Existing Phase 1 migration history required: $state"; exit 1; }
assert_legacy_web_video_compatibility() {
  [[ "$release_publish_web" == false ]] || return 0
  local unavailable
  unavailable="$(query <<'SQL'
SELECT count(*) FROM assets a WHERE a.kind = 'VIDEO' AND a.status = 'READY'
AND NOT (CASE WHEN EXISTS (SELECT 1 FROM asset_representations r WHERE r.asset_id = a.id)
  THEN EXISTS (SELECT 1 FROM asset_representations r WHERE r.asset_id = a.id AND r.role = 'PLAYBACK' AND r.state = 'READY')
  ELSE a.playback_status = 'READY' AND a.playback_storage_key IS NOT NULL END);
SQL
)"
  [[ "$unavailable" == 0 ]] || {
    echo "Cannot update API alone: $unavailable videos require the new web playback fallback." >&2
    query <<'SQL'
SELECT json_build_object('assetId', a.id, 'projectId', a.project_id, 'projectStatus', p.status,
  'legacyPlaybackStatus', a.playback_status,
  'representations', (SELECT json_agg(json_build_object('role', r.role, 'state', r.state)) FROM asset_representations r WHERE r.asset_id = a.id))
FROM assets a LEFT JOIN projects p ON p.id = a.project_id
WHERE a.kind = 'VIDEO' AND a.status = 'READY'
AND NOT (CASE WHEN EXISTS (SELECT 1 FROM asset_representations r WHERE r.asset_id = a.id)
  THEN EXISTS (SELECT 1 FROM asset_representations r WHERE r.asset_id = a.id AND r.role = 'PLAYBACK' AND r.state = 'READY')
  ELSE a.playback_status = 'READY' AND a.playback_storage_key IS NOT NULL END);
SQL
    return 1
  }
}
assert_legacy_web_video_compatibility
maintenance_started=false
cleanup() {
  local code=$?
  trap - EXIT INT TERM HUP
  if [[ "$maintenance_started" == true ]]; then
    if "$control" drain; then
      echo 'Update failed; mutations are drained. Keep the additive schema and restore a verified runtime before resuming uploads.' >&2
    else
      echo 'CRITICAL: update failed and draining could not be confirmed. Inspect runtime processes immediately.' >&2
    fi
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
assert_legacy_web_video_compatibility
"$control" backup "video-order-${RELEASE_SOURCE_SHA}"
mkdir -p "$CUTOVER_STATE_DIR"
audit_prefix="${CUTOVER_STATE_DIR}/video-order-${RELEASE_SOURCE_SHA}-$(date -u +%Y%m%dT%H%M%SZ)"
query > "${audit_prefix}.before.tsv" <<'SQL'
SELECT id, project_id, exhibition_id, kind, status, storage_key, playback_storage_key FROM assets ORDER BY id;
SQL
"$control" release-migrate apply-expand
"$control" release-assert phase1
query > "${audit_prefix}.after.tsv" <<'SQL'
SELECT id, project_id, exhibition_id, kind, status, storage_key, playback_storage_key FROM assets ORDER BY id;
SQL
cmp "${audit_prefix}.before.tsv" "${audit_prefix}.after.tsv"
query <<'SQL'
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM assets WHERE kind = 'VIDEO' AND status = 'READY' AND video_sort_order IS NULL) THEN
    RAISE EXCEPTION 'READY video has no assigned order';
  END IF;
END $$;
SELECT 'ready_videos=' || count(*) || ',main_videos=' || count(*) FILTER (WHERE video_sort_order = 0)
FROM assets WHERE kind = 'VIDEO' AND status = 'READY';
SQL
"$control" up
"$control" release-assert phase1
http_status="$(curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
  --output "${audit_prefix}.health.json" --write-out '%{http_code}' "${API_PUBLIC_URL%/}/api/health")"
[[ "$http_status" == 200 ]]
podman run --rm -i --entrypoint node "$API_IMAGE" -e '
  const fs = require("node:fs");
  const health = JSON.parse(fs.readFileSync(0, "utf8"));
  if (health.ok !== true || health.state !== "ready" || health.checks?.db !== "ok") throw new Error("public API health failed");
' < "${audit_prefix}.health.json"
maintenance_started=false
trap - EXIT INT TERM HUP
printf '\nPhase 1 video-order update complete: %s\n' "$RELEASE_SOURCE_SHA"
