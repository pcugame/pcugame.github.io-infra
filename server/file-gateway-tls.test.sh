#!/bin/sh
# Isolated real nginx 1.27 TLS/auth_request regression; requires Docker + OpenSSL.
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
name=pcu-gateway-tls-test-$$
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || :; rm -rf "$work"; }
trap cleanup EXIT INT TERM
sh "$root/server/prepare-file-gateway-tls.sh" "$work/identity" >/dev/null
chmod 755 "$work" "$work/identity"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=pcu-file-auth.internal \
 -addext subjectAltName=DNS:pcu-file-auth.internal -keyout "$work/wrong.key" -out "$work/wrong.pem" >/dev/null 2>&1
# Run real generated TLS vhosts and both rendered NAS templates against the API
# report controller/service with an isolated in-memory capability repository.
ROOT="$root" WORK="$work" NAME="$name" node --import tsx "$root/server/file-gateway-tls.test.mjs"
