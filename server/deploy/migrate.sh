# shellcheck shell=bash
# Source-only module: loaded by deploy.sh in its shared release context.

run_release_entry() {
  local entry="$1"
  shift
  load_env
  require_immutable_release_images
  load_runtime_env
  validate_production_boundaries
  assert_quadlet_adopted
  validate_release_source_identity "$MIGRATION_IMAGE"
  mkdir -p "$CUTOVER_STATE_DIR"
  assert_postgres_running
  release_common_args
  podman run "${RELEASE_CONTAINER_ARGS[@]}" --entrypoint node "$MIGRATION_IMAGE" "$entry" "$@"
}

do_release_migration() {
  local action="${1:-status}"
  if (( $# > 0 )); then shift; fi
  [[ "$action" == status || "$action" == apply-contract ]] || {
    echo "ERROR: release-migrate action must be status or apply-contract"
    return 1
  }
  (( $# == 0 )) || {
    echo "ERROR: release-migrate does not accept transition exception arguments"
    return 1
  }
  if [[ "$action" != status ]]; then
    assert_mutation_drained
    # Only subsequent migrations are supported; the initial contract transition
    # is retired. Keep the applied receipt/schema assertion before any SQL deploy.
    run_release_entry dist-release/scripts/release-migrate.js assert-runtime phase2
  fi
  run_release_entry dist-release/scripts/release-migrate.js "$action" "$@"
}

do_release_assert() {
  local phase="${1:-}"
  [[ "$phase" == phase2 ]] || {
    echo "ERROR: release-assert requires phase2"
    return 1
  }
  run_release_entry dist-release/scripts/release-migrate.js assert-runtime "$phase"
}

do_inventory_snapshot() {
  assert_mutation_drained
  local output="${1:-/release-state/garage-inventory-$(date -u +%Y%m%dT%H%M%SZ).json}"
  [[ "$output" == /release-state/* ]] || {
    echo "ERROR: inventory output must be under /release-state"
    return 1
  }
  run_release_entry dist-release/scripts/snapshot-garage-inventory.js "--output=$output"
}

