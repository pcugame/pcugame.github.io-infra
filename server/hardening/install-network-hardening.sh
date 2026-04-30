#!/usr/bin/env bash
# Configure fail2ban and nftables guardrails for the production host.
set -euo pipefail

SSH_PORT="${SSH_PORT:-5050}"
API_PORT="${API_PORT:-4000}"
PUBLIC_IFACE="${PUBLIC_IFACE:-}"
SSH_RATE_LIMIT="${SSH_RATE_LIMIT:-12/minute}"
SSH_RATE_BURST="${SSH_RATE_BURST:-30}"
FAIL2BAN_MAXRETRY="${FAIL2BAN_MAXRETRY:-5}"
FAIL2BAN_FINDTIME="${FAIL2BAN_FINDTIME:-10m}"
FAIL2BAN_BANTIME="${FAIL2BAN_BANTIME:-1h}"
INSTALL_PACKAGES="false"
DRY_RUN="false"

usage() {
  cat <<'EOF'
Usage: sudo bash install-network-hardening.sh [--install-packages] [--dry-run]

Environment:
  SSH_PORT            Public SSH port. Default: 5050
  API_PORT            API port to block externally. Default: 4000
  PUBLIC_IFACE        Optional public interface name. Empty means every non-loopback interface.
  SSH_RATE_LIMIT      nftables new SSH connection rate. Default: 12/minute
  SSH_RATE_BURST      nftables burst packet count. Default: 30
  FAIL2BAN_MAXRETRY   Default: 5
  FAIL2BAN_FINDTIME   Default: 10m
  FAIL2BAN_BANTIME    Default: 1h
EOF
}

while (($#)); do
  case "$1" in
    --install-packages)
      INSTALL_PACKAGES="true"
      ;;
    --dry-run)
      DRY_RUN="true"
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

if [[ "$INSTALL_PACKAGES" == "true" ]]; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y fail2ban nftables
  else
    echo "ERROR: --install-packages currently supports apt-get hosts only." >&2
    exit 1
  fi
fi

fail2ban_config="$(cat <<EOF
[sshd]
enabled = true
port = ${SSH_PORT}
filter = sshd
backend = systemd
maxretry = ${FAIL2BAN_MAXRETRY}
findtime = ${FAIL2BAN_FINDTIME}
bantime = ${FAIL2BAN_BANTIME}
EOF
)"

if [[ -n "$PUBLIC_IFACE" ]]; then
  iface_expr="iifname \"${PUBLIC_IFACE}\""
else
  iface_expr='iifname != "lo"'
fi

nft_config="$(cat <<EOF
table inet pcu_hardening {
  chain input {
    type filter hook input priority -5; policy accept;

    ${iface_expr} tcp dport ${SSH_PORT} ct state new limit rate over ${SSH_RATE_LIMIT} burst ${SSH_RATE_BURST} packets drop
    ${iface_expr} tcp dport ${API_PORT} drop
    ${iface_expr} tcp dport 111 drop
    ${iface_expr} udp dport 111 drop
  }
}
EOF
)"

if [[ "$DRY_RUN" == "true" ]]; then
  cat <<EOF
--- /etc/fail2ban/jail.d/sshd-5050.local ---
${fail2ban_config}

--- /etc/nftables.d/pcu-hardening.nft ---
${nft_config}
EOF
  exit 0
fi

for required in fail2ban-client nft systemctl; do
  if ! command -v "$required" >/dev/null 2>&1; then
    echo "ERROR: ${required} is required. Re-run with --install-packages on apt-based hosts, or install it manually." >&2
    exit 1
  fi
done

install -d -m 0755 /etc/fail2ban/jail.d /etc/nftables.d
printf '%s\n' "$fail2ban_config" > /etc/fail2ban/jail.d/sshd-5050.local
printf '%s\n' "$nft_config" > /etc/nftables.d/pcu-hardening.nft

if [[ ! -f /etc/nftables.conf ]]; then
  cat > /etc/nftables.conf <<'EOF'
#!/usr/sbin/nft -f
flush ruleset
include "/etc/nftables.d/*.nft"
EOF
elif ! grep -Eq '^[[:space:]]*include[[:space:]]+"/etc/nftables\.d/\*\.nft"' /etc/nftables.conf; then
  backup="/etc/nftables.conf.bak.$(date -u '+%Y%m%d%H%M%S')"
  cp -a /etc/nftables.conf "$backup"
  printf '\ninclude "/etc/nftables.d/*.nft"\n' >> /etc/nftables.conf
  echo "Backed up /etc/nftables.conf to ${backup}" >&2
fi

nft -c -f /etc/nftables.conf
systemctl enable --now nftables
systemctl reload nftables || systemctl restart nftables

fail2ban-client -t
systemctl enable --now fail2ban
systemctl restart fail2ban

cat >&2 <<EOF
Applied network hardening.

Recommended checks:
  fail2ban-client status sshd
  nft list table inet pcu_hardening
  ss -tulpen | grep -E ':(${SSH_PORT}|${API_PORT}|111)\\b'
EOF
