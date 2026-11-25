#!/usr/bin/env bash
set -euo pipefail
experiment_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
image_name=${NICKNAME_LORA_IMAGE:-pcu-nickname-lora:rocm7.2}
if [[ ! -c /dev/kfd ]]; then
  echo 'No /dev/kfd: ROCm training is unavailable on this machine.' >&2
  exit 2
fi
source_revision=$(git -C "$experiment_dir" rev-parse HEAD)
image_id=$(docker image inspect "$image_name" --format '{{.Id}}')
# Loopback inference works with the repository CLI on the host. No host services,
# GPU processes, drivers, or production machines are started/stopped by this script.
exec docker run --rm --init --network host --shm-size 2g \
  --device /dev/kfd --device /dev/dri \
  --user "$(id -u):$(id -g)" --group-add "$(stat -c '%g' /dev/kfd)" \
  -e NICKNAME_SOURCE_SHA="$source_revision" -e NICKNAME_IMAGE_ID="$image_id" \
  -e HF_HUB_DISABLE_XET="${HF_HUB_DISABLE_XET:-1}" \
  -e HF_HUB_DOWNLOAD_TIMEOUT="${HF_HUB_DOWNLOAD_TIMEOUT:-180}" \
  -e XDG_CACHE_HOME=/work/artifacts/cache -e TRITON_CACHE_DIR=/work/artifacts/triton \
  -e TORCH_HOME=/work/artifacts/torch \
  -v "$experiment_dir:/work" "$image_name" "$@"
