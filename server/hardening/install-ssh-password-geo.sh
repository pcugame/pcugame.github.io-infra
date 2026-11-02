#!/usr/bin/env bash
# Permit operator password access, while deployment accounts remain key-only.
# The legacy filename replaces the former country-specific policy in place.
set -euo pipefail

SSHD_CONFIG_DIR="${SSHD_CONFIG_DIR:-/etc/ssh/sshd_config.d}"
SSHD_MAIN_CONFIG="${SSHD_MAIN_CONFIG:-/etc/ssh/sshd_config}"
OUTPUT_FILE="${OUTPUT_FILE:-${SSHD_CONFIG_DIR}/99-password-geo.conf}"
PASSWORD_COUNTRIES="${PASSWORD_COUNTRIES:-}"
PASSWORD_LOGIN_USER="${PASSWORD_LOGIN_USER:-song}"
SSH_ALLOW_USERS="${SSH_ALLOW_USERS:-song gh-deploy}"
RELOAD_SERVICE="${RELOAD_SERVICE:-true}"
DRY_RUN="false"

usage() {
  cat <<'EOF'
Usage: sudo bash install-ssh-password-geo.sh [--dry-run] [--no-reload]

Environment:
  SSH_ALLOW_USERS      Space-separated users allowed to SSH. Default: "song gh-deploy"
  PASSWORD_COUNTRIES  Retired. Nonempty values are rejected.
  PASSWORD_LOGIN_USER  User allowed password login from any source. Default: "song"
  OUTPUT_FILE         sshd drop-in path. Default: /etc/ssh/sshd_config.d/99-password-geo.conf
  SSHD_MAIN_CONFIG    Main sshd config path. Default: /etc/ssh/sshd_config
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

if [[ -n "$PASSWORD_COUNTRIES" ]]; then
  echo "ERROR: country-based access is retired; set PASSWORD_LOGIN_USER instead." >&2
  exit 2
fi

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

generate_config() {
  local generated_at
  generated_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

  cat <<EOF
# Managed by server/hardening/install-ssh-password-geo.sh
# Generated: ${generated_at}
# Password access: ${PASSWORD_LOGIN_USER}; all other allowed users are key-only
PubkeyAuthentication yes
AuthenticationMethods publickey
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowUsers ${SSH_ALLOW_USERS}

Match User ${PASSWORD_LOGIN_USER}
    AuthenticationMethods any
    PasswordAuthentication yes
    KbdInteractiveAuthentication yes

Match all
EOF
}

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

config_file="${tmp_dir}/99-password-geo.conf"

generate_config > "$config_file"

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
