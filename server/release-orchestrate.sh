#!/usr/bin/env bash
# Each workflow phase runs as its own fail-closed Bash child process.
set -euo pipefail
export PATH="$PATH:/usr/local/bin:/usr/bin"
export DEPLOY_DIR="${DEPLOY_DIR:-/srv/graduationproject_v2}"
export CUTOVER_STATE_DIR="${DEPLOY_DIR}/cutover-state"
command="${1:-}"
if [[ "$command" == recover || "$command" == assert-pre-migration ]]; then
  exec node "${DEPLOY_DIR}/release-recovery.mjs" "$command" "${RELEASE_RUN_KEY:?}"
fi
[[ "${RELEASE_SOURCE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid release source SHA' >&2; exit 1; }
[[ "${FINAL_IMAGE:-}" =~ ^ghcr\.io/pcugame/pcu-graduationproject-v2-api@sha256:[0-9a-f]{64}$ ]] || { echo 'Invalid immutable release image' >&2; exit 1; }
export API_IMAGE="$FINAL_IMAGE" MIGRATION_IMAGE="$FINAL_IMAGE"
export RELEASE_SCHEMA_PHASE=phase2

deploy() { bash "${DEPLOY_DIR}/deploy.sh" "$@"; }
login() { printf '%s' "${GHCR_TOKEN:?}" | podman login ghcr.io -u "${GHCR_USERNAME:?}" --password-stdin; }
health() {
  # API smoke inside deploy.sh precedes workers. This gate checks the complete runtime.
  for name in gp-api gp-worker-game-validation gp-worker-webgl gp-worker-video gp-worker-image gp-worker-export gp-worker-project-publication; do
    [[ "$(podman inspect --format '{{.State.Status}}' "$name")" == running ]]
    [[ "$(systemctl --user is-active "${name}.service")" == active ]]
    deployed_id="$(podman inspect "$name" --format '{{.Image}}')"
    actual_source="$(podman image inspect "$deployed_id" --format '{{ index .Labels "org.opencontainers.image.revision" }}')"
    actual_digest="$(podman image inspect "$deployed_id" --format '{{.Digest}}')"
    [ "$actual_source" = "$RELEASE_SOURCE_SHA" ]
    [ "$actual_digest" = "${FINAL_IMAGE##*@}" ]
  done
  podman exec gp-api wget -qO- http://localhost:4000/api/health | grep -q '"ok":true'
}
final_smoke() {
  health
  SMOKE_PUBLIC_OBJECT_URL="$(node "${DEPLOY_DIR}/release-smoke-target.mjs" read "$RELEASE_SOURCE_SHA")"
  node "${DEPLOY_DIR}/smoke-data-plane.mjs" "$SMOKE_PUBLIC_OBJECT_URL"
  umask 077
  printf 'source_sha=%s\nimage=%s\n' "$RELEASE_SOURCE_SHA" "$FINAL_IMAGE" > "${CUTOVER_STATE_DIR}/deployed-${RELEASE_SOURCE_SHA}.txt"
  printf 'Deployed source: %s\nDeployed image: %s\n' "$RELEASE_SOURCE_SHA" "$FINAL_IMAGE"
}
case "$command" in
  preflight)
    login
    deploy release-artifact-preflight phase2
    deploy release-assert phase2
    node "${DEPLOY_DIR}/release-smoke-target.mjs" prepare "$RELEASE_SOURCE_SHA"
    bash "${DEPLOY_DIR}/ip-ban-audit.sh" before
    ;;
  backup)
    bash "${DEPLOY_DIR}/release-db-snapshot.sh" "$RELEASE_SOURCE_SHA"
    node "${DEPLOY_DIR}/release-recovery.mjs" capture "${RELEASE_RUN_KEY:?}"
    deploy drain
    deploy backup "release-${RELEASE_SOURCE_SHA}"
    ;;
  migrate)
    deploy release-migrate status
    # Persist and fsync the attempt before any SQL, including failed migrations.
    node "${DEPLOY_DIR}/release-recovery.mjs" mark-migration "${RELEASE_RUN_KEY:?}"
    deploy release-migrate apply-contract
    ;;
  activate)
    # No previous-image rollback after the migration-attempt boundary.
    deploy up
    deploy release-migrate status
    bash "${DEPLOY_DIR}/ip-ban-audit.sh" after
    ;;
  health) health ;;
  smoke)
    web_verified=false
    for ((attempt=0; attempt<60; attempt++)); do
      if deploy verify-final-web "$RELEASE_SOURCE_SHA"; then web_verified=true; break; fi
      sleep 5
    done
    [[ "$web_verified" == true ]] || { echo 'Published web did not expose the exact release SHA' >&2; exit 1; }
    final_smoke
    ;;
  forward-fix)
    login
    deploy release-artifact-preflight phase2
    node "${DEPLOY_DIR}/release-smoke-target.mjs" prepare "$RELEASE_SOURCE_SHA"
    deploy drain
    deploy backup "forward-fix-${RELEASE_SOURCE_SHA}"
    deploy release-assert phase2
    deploy up
    final_smoke
    ;;
  *) echo 'Expected preflight, backup, migrate, activate, health, smoke, forward-fix, assert-pre-migration or recover' >&2; exit 1 ;;
esac
