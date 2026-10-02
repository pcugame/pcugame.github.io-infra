# shellcheck shell=bash
# Source-only module: loaded by deploy.sh in its shared release context.

do_backup() {
  local label="${1:-manual}"
  load_env
  load_runtime_env
  assert_postgres_running
  assert_mutation_drained
  [[ "$label" =~ ^[A-Za-z0-9._-]+$ ]] || {
    echo "ERROR: backup label contains unsupported characters"
    return 1
  }
  local backup_dir="${DEPLOY_DIR}/backups"
  local backup_file="${backup_dir}/${label}-$(date -u +%Y%m%dT%H%M%SZ).dump"
  umask 077
  mkdir -p "$backup_dir"
  if ! podman exec "$PG_CONTAINER" sh -c 'exec pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$backup_file"; then
    rm -f "$backup_file"
    echo "ERROR: PostgreSQL backup failed"
    return 1
  fi
  [[ -s "$backup_file" ]] || {
    rm -f "$backup_file"
    echo "ERROR: PostgreSQL backup is empty"
    return 1
  }
  sha256sum "$backup_file" > "${backup_file}.sha256"
  echo "PostgreSQL backup: $backup_file"
}

