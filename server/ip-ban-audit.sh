#!/usr/bin/env bash
# Read-only aggregate audit for the automatic protected-download IP ban.
set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:-gp-postgres}"
API_CONTAINER="${API_CONTAINER:-gp-api}"
MODE="${1:-}"

die() {
  echo "ERROR: $*" >&2
  exit 2
}

[[ $# -eq 1 ]] || die "usage: $0 <before|after>"
[[ "$MODE" == before || "$MODE" == after ]] || die "mode must be before or after"
[[ "$PG_CONTAINER" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] || die "PG_CONTAINER must be a safe container name"
[[ "$API_CONTAINER" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] || die "API_CONTAINER must be a safe container name"

run_sql() {
  podman exec -i "$PG_CONTAINER" sh -c \
    'exec psql -X -qAt --set ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' 2>/dev/null
}

if [[ "$MODE" == before ]]; then
  counts="$(run_sql <<'SQL'
BEGIN READ ONLY;
SELECT count(*) FILTER (WHERE reason IN (
  'Rate limit exceeded (game download)',
  'Rate limit exceeded (protected asset download)',
  'Protected download IP abuse ceiling exceeded'
))::text || '|' ||
count(*) FILTER (WHERE reason NOT IN (
  'Rate limit exceeded (game download)',
  'Rate limit exceeded (protected asset download)',
  'Protected download IP abuse ceiling exceeded'
))::text
FROM banned_ips;
COMMIT;
SQL
  )" || die "could not read the pre-migration banned-IP counts"
  [[ "$counts" =~ ^([0-9]+)\|([0-9]+)$ ]] || die "PostgreSQL returned invalid aggregate counts"
  printf 'auto_candidates=%s\nlegacy=%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
  exit 0
fi

auto_ban_disabled="$(podman exec "$API_CONTAINER" node -e \
  'process.stdout.write(String(process.env.DOWNLOAD_AUTO_IP_BAN_ENABLED === "false"))' 2>/dev/null)" \
  || die "could not read the API automatic-ban setting"
[[ "$auto_ban_disabled" == true ]] || die "DOWNLOAD_AUTO_IP_BAN_ENABLED is not false"
echo 'download_auto_ip_ban_enabled=false'

counts="$(run_sql <<'SQL'
BEGIN READ ONLY;
SELECT
  count(*) FILTER (WHERE source = 'AUTO' AND disabled_at IS NULL)::text || '|' ||
  count(*) FILTER (WHERE source = 'AUTO' AND disabled_at IS NOT NULL)::text || '|' ||
  count(*) FILTER (WHERE source = 'MANUAL' AND disabled_at IS NULL)::text || '|' ||
  count(*) FILTER (WHERE source = 'MANUAL' AND disabled_at IS NOT NULL)::text || '|' ||
  count(*) FILTER (WHERE source = 'LEGACY' AND disabled_at IS NULL)::text || '|' ||
  count(*) FILTER (WHERE source = 'LEGACY' AND disabled_at IS NOT NULL)::text || '|' ||
  count(*) FILTER (WHERE source NOT IN ('AUTO', 'MANUAL', 'LEGACY') OR source IS NULL)::text
FROM banned_ips;
COMMIT;
SQL
)" || die "could not read the post-migration banned-IP counts"
[[ "$counts" =~ ^([0-9]+)\|([0-9]+)\|([0-9]+)\|([0-9]+)\|([0-9]+)\|([0-9]+)\|([0-9]+)$ ]] \
  || die "PostgreSQL returned invalid aggregate counts"
auto_active="${BASH_REMATCH[1]}"
auto_disabled="${BASH_REMATCH[2]}"
manual_active="${BASH_REMATCH[3]}"
manual_disabled="${BASH_REMATCH[4]}"
legacy_active="${BASH_REMATCH[5]}"
legacy_disabled="${BASH_REMATCH[6]}"
unknown_source="${BASH_REMATCH[7]}"
printf 'auto_active=%s\nauto_disabled=%s\nmanual_active=%s\nmanual_disabled=%s\nlegacy_active=%s\nlegacy_disabled=%s\nunknown_source=%s\n' \
  "$auto_active" "$auto_disabled" "$manual_active" "$manual_disabled" \
  "$legacy_active" "$legacy_disabled" "$unknown_source"
[[ "$auto_active" == 0 ]] || die "automatic IP bans remain active while automatic banning is disabled"
[[ "$unknown_source" == 0 ]] || die "database contains an unknown banned-IP source"
