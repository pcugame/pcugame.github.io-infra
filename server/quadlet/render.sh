#!/usr/bin/env bash
# Offline topology only. Never source deployment .env or inspect runtime env files.
set -euo pipefail
umask 077
[[ $# == 1 ]] || { echo 'Usage: render.sh OUTPUT_DIRECTORY (new directory)' >&2; exit 2; }
renderer_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# Resolve executables before clearing the environment; only topology reaches Python.
python_bin="$(command -v python3)"
env_bin="$(command -v env)"
settings=()
for name in API_IMAGE DEPLOY_DIR API_BIND_HOST API_PORT NAS_EXPORT_HOST_PATH NAS_EXPORT_PATH S3_TLS_CA_HOST_PATH APP_RUNTIME_ENV_FILE API_RUNTIME_ENV_FILE POSTGRES_RUNTIME_ENV_FILE; do
  if [[ -v "$name" ]]; then settings+=("$name=${!name}"); fi
done
exec "$env_bin" -i "${settings[@]}" "$python_bin" "$renderer_dir/render.py" "$1"
