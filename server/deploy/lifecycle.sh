# shellcheck shell=bash
# Source-only module: loaded by deploy.sh in its shared release context.

assert_quadlet_adopted() {
  QUADLET_DIR="${QUADLET_DIR:-${HOME}/.config/containers/systemd}"
  export API_IMAGE DEPLOY_DIR API_BIND_HOST APP_RUNTIME_ENV_FILE API_RUNTIME_ENV_FILE POSTGRES_RUNTIME_ENV_FILE
  local staging
  staging="$(mktemp -d)"
  if ! bash "$QUADLET_HELPERS/render.sh" "$staging/expected" || ! systemctl --user show-environment | python3 "$QUADLET_HELPERS/check-installed.py" "$staging/expected" "$QUADLET_DIR" --manager-env; then
    rm -rf "$staging"
    return 1
  fi
  rm -rf "$staging"
  local unit definition source fragment pending dropins
  for unit in "$POD_UNIT" "$PG_UNIT" "${APP_UNITS[@]}" gp-pg-data-volume.service; do
    definition="${unit%.service}.container"
    [[ "$unit" != "$POD_UNIT" ]] || definition=graduationproject.pod
    [[ "$unit" != gp-pg-data-volume.service ]] || definition=gp-pg-data.volume
    pending="$(systemctl --user show "$unit" --property=NeedDaemonReload --value)" || return 1
    dropins="$(systemctl --user show "$unit" --property=DropInPaths --value)" || return 1
    [[ "$pending" == no && -z "$dropins" ]] || {
      echo "ERROR: $unit has pending reload or unsupported service drop-ins"
      return 1
    }
    source="$(systemctl --user show "$unit" --property=SourcePath --value)" || return 1
    fragment="$(systemctl --user show "$unit" --property=FragmentPath --value)" || return 1
    [[ "$source" == "$QUADLET_DIR/$definition" && "$fragment" == */generator*/"$unit" ]] || {
      echo "ERROR: $unit must be the installed Quadlet-generated service (legacy generated units are unsupported)"
      return 1
    }
  done
  assert_foundation_active
  assert_postgres_running
}

assert_foundation_active() {
  local unit
  for unit in "$POD_UNIT" "$PG_UNIT"; do
    systemctl --user is-active --quiet "$unit" || {
      echo "ERROR: adopted pod and PostgreSQL must already be active; automatic first installation/cutover is unsupported"
      return 1
    }
  done
}

stop_application_units() {
  systemctl --user stop "${APP_UNITS[@]}" || return 1
  assert_application_stopped
}

runtime_container_state() {
  local state exists_status=0
  if state="$(podman inspect --format '{{.State.Status}}' "$1" 2>/dev/null)"; then
    echo "$state"
    return 0
  fi
  podman container exists "$1" 2>/dev/null || exists_status=$?
  [[ "$exists_status" == 1 ]] || { echo "ERROR: cannot verify container state: $1" >&2; return 1; }
  echo missing
}

assert_application_stopped() {
  local unit state ctr
  for unit in "${APP_UNITS[@]}"; do
    state="$(systemctl --user show "$unit" --property=ActiveState --value)" || return 1
    [[ "$state" == inactive ]] || { echo "ERROR: application service is not inactive: $unit"; return 1; }
  done
  for ctr in "${RUNTIME_CONTAINERS[@]}"; do
    state="$(runtime_container_state "$ctr")" || return 1
    [[ "$state" == missing || "$state" == exited || "$state" == dead ]] || {
      echo "ERROR: failed to drain mutation process $ctr (state: $state)"
      return 1
    }
  done
}

assert_mutation_drained() {
  [[ -f "${CUTOVER_STATE_DIR}/mutation-drained" ]] || {
    echo "ERROR: mutation drain marker is absent; run '$0 drain' first"
    return 1
  }
  assert_application_stopped
}

do_drain() {
  load_env
  require_immutable_release_images
  load_runtime_env
  assert_quadlet_adopted
  mkdir -p "$CUTOVER_STATE_DIR"
  rm -f "${CUTOVER_STATE_DIR}/mutation-drained"
  stop_application_units
  assert_postgres_running
  {
    echo "drained_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "api_image=${API_IMAGE}"
  } > "${CUTOVER_STATE_DIR}/mutation-drained"
  chmod 600 "${CUTOVER_STATE_DIR}/mutation-drained"
  echo "Mutation drain complete; PostgreSQL remains online."
}

do_down() {
  load_env
  require_immutable_release_images
  load_runtime_env
  assert_quadlet_adopted
  rm -f "${CUTOVER_STATE_DIR}/mutation-drained"
  stop_application_units
  systemctl --user stop "$PG_UNIT"
  systemctl --user stop "$POD_UNIT"
  echo "Down complete. Quadlet volume '$PG_VOLUME' preserved."
}

do_logs() {
  local target="${1:-api}"
  case "$target" in
    api|app) podman logs -f "$API_CONTAINER" ;;
    pg|postgres|db) podman logs -f "$PG_CONTAINER" ;;
    game) podman logs -f "$GAME_WORKER_CONTAINER" ;;
    webgl) podman logs -f "$WEBGL_WORKER_CONTAINER" ;;
    video) podman logs -f "$VIDEO_WORKER_CONTAINER" ;;
    image) podman logs -f "$IMAGE_WORKER_CONTAINER" ;;
    export) podman logs -f "$EXPORT_WORKER_CONTAINER" ;;
    *) echo "Usage: $0 logs [api|pg|game|webgl|video|image|export]" ;;
  esac
}

do_status() {
  echo "=== Pod ==="
  podman pod ps --filter "name=$POD_NAME" 2>/dev/null || echo "(no pod)"
  echo ""
  echo "=== Containers ==="
  podman ps -a --pod --filter "pod=$POD_NAME" 2>/dev/null || echo "(no containers)"
  echo ""
  echo "=== Volume ==="
  podman volume inspect "$PG_VOLUME" --format '{{.Name}} -> {{.Mountpoint}}' 2>/dev/null || echo "(no volume)"
}

