#!/bin/sh
set -eu

fail() {
  echo "data-plane environment validation failed: $*" >&2
  exit 1
}

if [ -n "${UPLOAD_PART_GLOBAL_CONNECTIONS:-}" ]; then
  case "$UPLOAD_PART_GLOBAL_CONNECTIONS:$UPLOAD_PART_PER_IP_CONNECTIONS" in
    *[!0-9:]*|:*|*:) fail "connection limits must be positive integers" ;;
  esac
  [ "$UPLOAD_PART_PER_IP_CONNECTIONS" -ge 50 ] \
    || fail "UPLOAD_PART_PER_IP_CONNECTIONS must support at least 50 NAT users"
  [ "$UPLOAD_PART_GLOBAL_CONNECTIONS" -ge "$UPLOAD_PART_PER_IP_CONNECTIONS" ] \
    || fail "global connection limit must be at least the per-IP ceiling"
fi

if [ -n "${GARAGE_PUBLIC_BUCKET_HOST:-}" ]; then
  case "${S3_BUCKET_PUBLIC:-}" in
    ''|*[!a-z0-9.-]*) fail "S3_BUCKET_PUBLIC is not a DNS-compatible bucket name" ;;
  esac
  expected="${S3_BUCKET_PUBLIC}.web.garage.localhost"
  [ "$GARAGE_PUBLIC_BUCKET_HOST" = "$expected" ] \
    || fail "GARAGE_PUBLIC_BUCKET_HOST must equal $expected"
  for origin in "$PUBLIC_CORS_ORIGIN_PRIMARY" "$PUBLIC_CORS_ORIGIN_SECONDARY" "$WEB_PUBLIC_ORIGIN"; do
    case "$origin" in
      http://*|https://*) ;;
      *) fail "public origins must be exact HTTP(S) origins" ;;
    esac
    case "${origin#*://}" in
      ''|*/*|*\**|*' '*|*\"*|*\'*) fail "public origins must not contain a path, wildcard, space, or quote" ;;
    esac
  done
fi
