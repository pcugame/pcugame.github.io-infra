#!/usr/bin/env bash
# Generate and apply an sshd policy that keeps pubkey auth global, while
# allowing password auth only from KR, JP, and the Tailscale CGNAT range.
set -euo pipefail

SSHD_CONFIG_DIR="${SSHD_CONFIG_DIR:-/etc/ssh/sshd_config.d}"
SSHD_MAIN_CONFIG="${SSHD_MAIN_CONFIG:-/etc/ssh/sshd_config}"
OUTPUT_FILE="${OUTPUT_FILE:-${SSHD_CONFIG_DIR}/99-password-geo.conf}"
CIDR_SOURCE_BASE="${CIDR_SOURCE_BASE:-https://www.ipdeny.com/ipblocks/data/aggregated}"
PASSWORD_COUNTRIES="${PASSWORD_COUNTRIES:-kr jp}"
TAILSCALE_CIDR="${TAILSCALE_CIDR:-100.64.0.0/10}"
SSH_ALLOW_USERS="${SSH_ALLOW_USERS:-song gh-deploy}"
MATCH_CHUNK_SIZE="${MATCH_CHUNK_SIZE:-80}"
RELOAD_SERVICE="${RELOAD_SERVICE:-true}"
DRY_RUN="false"

usage() {
  cat <<'EOF'
Usage: sudo bash install-ssh-password-geo.sh [--dry-run] [--no-reload]

Environment:
  SSH_ALLOW_USERS      Space-separated users allowed to SSH. Default: "song gh-deploy"
  PASSWORD_COUNTRIES  Space-separated ISO country codes. Default: "kr jp"
  TAILSCALE_CIDR      Tailscale password-allowed CIDR. Default: "100.64.0.0/10"
  OUTPUT_FILE         sshd drop-in path. Default: /etc/ssh/sshd_config.d/99-password-geo.conf
  SSHD_MAIN_CONFIG    Main sshd config path. Default: /etc/ssh/sshd_config
  CIDR_SOURCE_BASE    Country CIDR source base URL.
EOF
}

while (($#)); do
  case "$1" in
    --dry-run)
      DRY_RUN="true"
      ;;
    --no-reload)
      RELOAD_SERVICE="false"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [[ "$DRY_RUN" != "true" && "${EUID}" -ne 0 ]]; then
  echo "ERROR: run as root, or use --dry-run to print the generated config." >&2
  exit 1
fi

find_sshd() {
  command -v sshd 2>/dev/null && return 0
  for candidate in /usr/sbin/sshd /sbin/sshd; do
    [[ -x "$candidate" ]] && printf '%s\n' "$candidate" && return 0
  done
  return 1
}

fetch_country_cidrs() {
  local country="$1"
  local url="${CIDR_SOURCE_BASE}/${country}-aggregated.zone"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$url"
  else
    echo "ERROR: curl or wget is required to fetch ${url}" >&2
    return 1
  fi
}

generate_config() {
  local cidr_file="$1"
  local generated_at
  generated_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

  cat <<EOF
# Managed by server/hardening/install-ssh-password-geo.sh
# Generated: ${generated_at}
# Source: ${CIDR_SOURCE_BASE}/{kr,jp}-aggregated.zone plus ${TAILSCALE_CIDR}
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowUsers ${SSH_ALLOW_USERS}

EOF

  local chunk=()
  local cidr
  while IFS= read -r cidr; do
    [[ -z "$cidr" ]] && continue
    chunk+=("$cidr")
    if ((${#chunk[@]} >= MATCH_CHUNK_SIZE)); then
      emit_match_chunk "${chunk[@]}"
      chunk=()
    fi
  done < "$cidr_file"

  if ((${#chunk[@]} > 0)); then
    emit_match_chunk "${chunk[@]}"
  fi
}

emit_match_chunk() {
  local joined
  local IFS=,
  joined="$*"
  cat <<EOF
Match Address ${joined}
    PasswordAuthentication yes
    KbdInteractiveAuthentication yes

EOF
}

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

cidr_file="${tmp_dir}/password-cidrs.txt"
raw_cidr_file="${tmp_dir}/raw-cidrs.txt"
config_file="${tmp_dir}/99-password-geo.conf"

printf '%s\n' "$TAILSCALE_CIDR" > "$raw_cidr_file"
for country in $PASSWORD_COUNTRIES; do
  echo "Fetching ${country^^} CIDRs from ${CIDR_SOURCE_BASE}/${country}-aggregated.zone..." >&2
  fetch_country_cidrs "$country" >> "$raw_cidr_file"
done

grep -E '^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$' "$raw_cidr_file" | sort -u > "$cidr_file"

if [[ ! -s "$cidr_file" ]]; then
  echo "ERROR: no valid IPv4 CIDRs were generated." >&2
  exit 1
fi

generate_config "$cidr_file" > "$config_file"
echo "Generated $(wc -l < "$cidr_file") password-allowed CIDRs." >&2

if [[ "$DRY_RUN" == "true" ]]; then
  cat "$config_file"
  exit 0
fi

sshd_bin="$(find_sshd)" || {
  echo "ERROR: sshd binary not found." >&2
  exit 1
}

install -d -m 0755 "$SSHD_CONFIG_DIR"
if [[ -f "$SSHD_MAIN_CONFIG" ]] && ! grep -Eq '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/\*\.conf' "$SSHD_MAIN_CONFIG"; then
  echo "WARNING: ${SSHD_MAIN_CONFIG} does not appear to include /etc/ssh/sshd_config.d/*.conf." >&2
  echo "WARNING: add that Include before relying on ${OUTPUT_FILE}." >&2
fi

backup_file=""
if [[ -f "$OUTPUT_FILE" ]]; then
  backup_file="${OUTPUT_FILE}.bak.$(date -u '+%Y%m%d%H%M%S')"
  cp -a "$OUTPUT_FILE" "$backup_file"
  echo "Backed up existing config to ${backup_file}" >&2
fi

restore_backup() {
  if [[ -n "$backup_file" && -f "$backup_file" ]]; then
    cp -a "$backup_file" "$OUTPUT_FILE"
  else
    rm -f "$OUTPUT_FILE"
  fi
}

install -m 0644 "$config_file" "$OUTPUT_FILE"

if ! "$sshd_bin" -t; then
  echo "ERROR: sshd config validation failed. Restoring previous config." >&2
  restore_backup
  "$sshd_bin" -t || true
  exit 1
fi

echo "sshd config validation passed." >&2

if [[ "$RELOAD_SERVICE" == "true" ]]; then
  if systemctl reload ssh 2>/dev/null; then
    echo "Reloaded ssh.service." >&2
  elif systemctl reload sshd 2>/dev/null; then
    echo "Reloaded sshd.service." >&2
  else
    echo "WARNING: could not reload ssh/sshd via systemctl; validate manually before closing your current session." >&2
  fi
else
  echo "Skipped reload because --no-reload was provided." >&2
fi

cat >&2 <<'EOF'

Recommended checks:
  sshd -T -C user=song,addr=203.250.133.230,host=gameserver | grep -E '^(passwordauthentication|pubkeyauthentication) '
  sshd -T -C user=song,addr=133.242.0.1,host=gameserver | grep -E '^(passwordauthentication|pubkeyauthentication) '
  sshd -T -C user=song,addr=8.8.8.8,host=gameserver | grep -E '^(passwordauthentication|pubkeyauthentication) '
  sshd -T -C user=song,addr=100.64.0.1,host=gameserver | grep -E '^(passwordauthentication|pubkeyauthentication) '
EOF
