#!/usr/bin/env bash
set -euo pipefail
case "${RELEASE_OPERATION:-}" in
  release|snapshot)
    [ -z "${FINAL_IMAGE:-}${FORWARD_FIX_ACKNOWLEDGEMENT:-}" ] || {
      echo 'release and snapshot reject manual image and forward-fix inputs' >&2; exit 1;
    } ;;
  forward-fix)
    [[ "${FINAL_IMAGE:-}" =~ ^ghcr\.io/pcugame/pcu-graduationproject-v2-api@sha256:[0-9a-f]{64}$ ]] || {
      echo 'final_api_image must be an immutable @sha256 digest in the authorized repository' >&2; exit 1;
    }
    [[ "${FORWARD_FIX_ACKNOWLEDGEMENT:-}" == I_ACKNOWLEDGE_CONTRACT_FORWARD_FIX ]] || {
      echo 'forward-fix requires the exact contract acknowledgement' >&2; exit 1;
    } ;;
  *) echo 'Unknown release operation' >&2; exit 1 ;;
esac
printf 'final_image=%s\n' "${FINAL_IMAGE:-}" >> "${GITHUB_OUTPUT:?}"
