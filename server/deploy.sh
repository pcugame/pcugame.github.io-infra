#!/usr/bin/env bash
# Release orchestration entry point. The workflow owns the gates between commands.
set -euo pipefail
DEPLOY_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
for module in common lifecycle preflight backup migrate activate smoke; do
  # shellcheck disable=SC1091
  source "${DEPLOY_SCRIPT_DIR}/deploy/${module}.sh"
done

# Activation is forward-only, including after a contract migration. API smoke
# runs inside activation before workers may start. No old-image rollback exists.
do_up() {
  do_activation_preflight
  do_activate
}

# ── Main ───────────────────────────────────────────────────────
case "${1:-up}" in
  up)      do_up ;;
  down)    do_down ;;
  drain)   do_drain ;;
  backup)  do_backup "${2:-manual}" ;;
  release-migrate) shift; do_release_migration "$@" ;;
  release-assert) do_release_assert "${2:-}" ;;
  inventory) do_inventory_snapshot "${2:-}" ;;
  capacity-preflight) do_capacity_preflight ;;
  boundary-preflight) load_env; load_runtime_env; validate_production_boundaries ;;
  release-artifact-preflight) do_release_artifact_preflight "${2:-}" ;;
  verify-final-web) do_verify_final_web "${2:-}" ;;
  # Restart uses the same gated application-only release transaction.
  restart) do_up ;;
  logs)    do_logs "${2:-api}" ;;
  status)  do_status ;;
  *)
    echo "Usage: $0 {up|down|drain|backup [label]|release-migrate [status|apply-contract]|release-assert phase2|inventory [/release-state/file]|capacity-preflight|boundary-preflight|release-artifact-preflight phase2|verify-final-web <git-sha>|restart|logs [api|pg|game|webgl|video|image|export]|status}"
    exit 1
    ;;
esac
