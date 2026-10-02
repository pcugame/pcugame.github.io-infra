# shellcheck shell=bash
# Source-only module: loaded by deploy.sh in its shared release context.

verify_running() {
  local name="$1"
  local label="$2"
  sleep 1  # give podman a moment to update state
  local state
  state=$(podman inspect --format '{{.State.Status}}' "$name" 2>/dev/null || echo "missing")
  if [[ "$state" != "running" ]]; then
    echo "ERROR: $label failed to start (state: $state)"
    podman logs "$name" --tail 30 2>/dev/null || true
    return 1
  fi
  echo "$label is running."
}

do_activate() {
  local release_schema_phase="${RELEASE_SCHEMA_PHASE:-}"
  mkdir -p "$CUTOVER_STATE_DIR"
  # Installed topology was checked byte-for-byte except immutable app Image lines.
  # Render again into a private staging directory and replace only app definitions.
  local staging ctr
  staging="$(mktemp -d)"
  if ! bash "$QUADLET_HELPERS/render.sh" "$staging/next"; then rm -rf "$staging"; return 1; fi
  rm -f "${CUTOVER_STATE_DIR}/mutation-drained"
  if ! stop_application_units; then rm -rf "$staging"; return 1; fi
  for ctr in "${RUNTIME_CONTAINERS[@]}"; do
    if ! install -m 600 "$staging/next/$ctr.container" "$QUADLET_DIR/$ctr.container"; then rm -rf "$staging"; return 1; fi
  done
  rm -rf "$staging"
  systemctl --user daemon-reload
  # Never start/restart the pod or PostgreSQL: StartWithPod could bypass this gate.
  assert_foundation_active
  assert_postgres_running
  release_common_args
  podman run "${RELEASE_CONTAINER_ARGS[@]}" --entrypoint node "$MIGRATION_IMAGE" \
    dist-release/scripts/release-migrate.js assert-runtime "$release_schema_phase"
  assert_foundation_active
  systemctl --user start "${API_CONTAINER}.service"
  verify_running "$API_CONTAINER" "API"
  do_api_smoke
  for ctr in "${RUNTIME_CONTAINERS[@]:1}"; do
    assert_foundation_active
    systemctl --user start "${ctr}.service"
    verify_running "$ctr" "$ctr"
  done
  echo "Forward-only Quadlet deploy complete; PostgreSQL and pod were retained."
}

