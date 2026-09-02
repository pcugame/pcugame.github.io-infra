#!/bin/sh
# Opt-in live test: ephemeral Garage + real nginx proxies, never production.
set -eu

if [ "${LIVE_GARAGE_PROXY_TEST:-0}" != 1 ]; then
  echo "SKIP live Garage proxy test (set LIVE_GARAGE_PROXY_TEST=1)"
  exit 0
fi

command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }
base_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project="pcu-garage-proxy-test-$$"
compose="docker compose --project-name $project -f $base_dir/docker-compose.yml -f $base_dir/docker-compose.integration.yml"
export NAS_UPLOAD_BIND_ADDRESS=127.0.0.1 NAS_UPLOAD_PORT=$((43000 + ($$ % 1000)))
export NAS_PUBLIC_BIND_ADDRESS=127.0.0.1 NAS_PUBLIC_PORT=$((44000 + ($$ % 1000)))
export S3_CORS_ALLOWED_ORIGINS=https://fixture.example.test
export PUBLIC_CORS_ORIGIN_PRIMARY=https://fixture.example.test
export PUBLIC_CORS_ORIGIN_SECONDARY=https://fixture-secondary.example.test
export WEB_PUBLIC_ORIGIN=https://fixture.example.test

cleanup() {
  $compose --profile nas-data-plane down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

$compose --profile nas-data-plane up -d --build --wait
$compose --profile nas-data-plane run --rm --no-deps --entrypoint sh garage-init -c '
  printf immutable-fixture >/tmp/fixture.txt
  AWS_ACCESS_KEY_ID=GK000000000000000000000000 \
  AWS_SECRET_ACCESS_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
  AWS_DEFAULT_REGION=garage \
  aws --endpoint-url http://garage:3900 s3api put-object \
    --bucket pcu-public --key fixture.txt --body /tmp/fixture.txt \
    --content-type text/plain >/dev/null
'

# Allocate multipart through Garage's private control plane, but sign and send
# UploadPart against the browser-visible nginx origin. This proves the proxy
# preserves the exact Host/path/query and checksum header used by SigV4.
upload_id=$($compose --profile nas-data-plane run --rm --no-deps --entrypoint sh garage-init -c '
  AWS_ACCESS_KEY_ID=GK000000000000000000000000 \
  AWS_SECRET_ACCESS_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
  AWS_DEFAULT_REGION=garage \
  aws --endpoint-url http://garage:3900 s3api create-multipart-upload \
    --bucket pcu-public --key proxy-upload.txt --content-type text/plain \
    --query UploadId --output text
')
[ -n "$upload_id" ]
part_body=direct-upload-part
part_checksum=$(printf %s "$part_body" | openssl dgst -sha256 -binary | base64 | tr -d '\n')
signed_part_url=$(cd "$base_dir/../api" && \
  PRESIGN_UPLOAD_ENDPOINT="http://127.0.0.1:${NAS_UPLOAD_PORT}" \
  PRESIGN_UPLOAD_ID="$upload_id" PRESIGN_UPLOAD_CHECKSUM="$part_checksum" \
  npx tsx -e '
    import { createS3Client } from "./src/lib/s3.ts";
    import { createMultipartPartPresigner } from "./src/lib/storage.ts";
    void (async () => {
      const client = createS3Client({
        S3_ENDPOINT: process.env.PRESIGN_UPLOAD_ENDPOINT!, S3_REGION: "garage",
        S3_ACCESS_KEY_ID: "GK000000000000000000000000",
        S3_SECRET_ACCESS_KEY: "0000000000000000000000000000000000000000000000000000000000000000",
        S3_FORCE_PATH_STYLE: true,
      });
      console.log(await createMultipartPartPresigner(client).presignUploadPart(
        "pcu-public", "proxy-upload.txt", process.env.PRESIGN_UPLOAD_ID!, 1, 60,
        process.env.PRESIGN_UPLOAD_CHECKSUM!,
      ));
      client.destroy();
    })();
  ')
tmp_part_headers=$(mktemp)
tmp_part_body=$(mktemp)
tmp_part_response=$(mktemp)
printf %s "$part_body" >"$tmp_part_body"
part_status=$(curl -sS -D "$tmp_part_headers" -o "$tmp_part_response" -w '%{http_code}' \
  -X PUT -H "x-amz-checksum-sha256: $part_checksum" --data-binary @"$tmp_part_body" "$signed_part_url")
if [ "$part_status" != 200 ]; then
  echo "UploadPart proxy returned HTTP $part_status" >&2
  cat "$tmp_part_response" >&2
  exit 1
fi
part_etag=$(sed -n 's/^[Ee][Tt][Aa][Gg]:[[:space:]]*//p' "$tmp_part_headers" | tr -d '\r"' | head -n1)
[ -n "$part_etag" ]
$compose --profile nas-data-plane run --rm --no-deps --entrypoint sh garage-init -c "
  AWS_ACCESS_KEY_ID=GK000000000000000000000000 \\
  AWS_SECRET_ACCESS_KEY=0000000000000000000000000000000000000000000000000000000000000000 \\
  AWS_DEFAULT_REGION=garage \\
  aws --endpoint-url http://garage:3900 s3api complete-multipart-upload \\
    --bucket pcu-public --key proxy-upload.txt --upload-id '$upload_id' \\
    --multipart-upload '{\"Parts\":[{\"ETag\":\"$part_etag\",\"PartNumber\":1}]}' >/dev/null
"

public="http://127.0.0.1:${NAS_PUBLIC_PORT}/fixture.txt"
upload="http://127.0.0.1:${NAS_UPLOAD_PORT}/pcu-protected/fixture"
tmp_headers=$(mktemp)
tmp_body=$(mktemp)
trap 'rm -f "$tmp_headers" "$tmp_body" "$tmp_part_headers" "$tmp_part_body" "$tmp_part_response"; cleanup' EXIT INT TERM

curl --retry 10 --retry-connrefused --retry-delay 1 -fsS \
  -D "$tmp_headers" -o "$tmp_body" -H 'Origin: https://fixture.example.test' "$public"
[ "$(cat "$tmp_body")" = immutable-fixture ]
grep -qi '^cache-control: public, max-age=31536000, immutable' "$tmp_headers"
[ "$(grep -ci '^access-control-allow-origin:' "$tmp_headers")" -eq 1 ]
curl -fsS -o "$tmp_body" "http://127.0.0.1:${NAS_PUBLIC_PORT}/proxy-upload.txt"
[ "$(cat "$tmp_body")" = "$part_body" ]
curl -fsSI "$public" | grep -qi '^content-length:'
curl -fsS -D "$tmp_headers" -o "$tmp_body" -H 'Range: bytes=0-8' "$public"
grep -q '^HTTP/.* 206' "$tmp_headers"
[ "$(cat "$tmp_body")" = immutable ]
etag=$(curl -fsSI "$public" | sed -n 's/^[Ee][Tt][Aa][Gg]:[[:space:]]*//p' | tr -d '\r' | head -n1)
[ -n "$etag" ]
[ "$(curl -sS -o /dev/null -w '%{http_code}' -H "If-None-Match: $etag" "$public")" = 304 ]
[ "$(curl -sS -D "$tmp_headers" -o /dev/null -w '%{http_code}' -H 'Range: bytes=999999-' "$public")" = 416 ]
grep -qi '^cache-control: no-store' "$tmp_headers"
[ "$(curl -sS -D "$tmp_headers" -o /dev/null -w '%{http_code}' "http://127.0.0.1:${NAS_PUBLIC_PORT}/missing")" = 404 ]
grep -qi '^cache-control: no-store' "$tmp_headers"

curl -fsS -D "$tmp_headers" -o /dev/null -X OPTIONS \
  -H 'Origin: https://fixture.example.test' \
  -H 'Access-Control-Request-Method: PUT' \
  -H 'Access-Control-Request-Headers: content-type,x-amz-checksum-sha256,x-amz-content-sha256,x-amz-date' \
  "$upload?uploadId=fixture&partNumber=1"
grep -qi '^access-control-allow-origin: https://fixture.example.test' "$tmp_headers"
grep -qi 'x-amz-checksum-sha256' "$tmp_headers"

$compose stop garage >/dev/null
code=$(curl -sS -D "$tmp_headers" -o /dev/null -w '%{http_code}' "$public")
case "$code" in 502|503|504) ;; *) echo "expected Garage outage response, got $code" >&2; exit 1 ;; esac
grep -qi '^cache-control: no-store' "$tmp_headers"

$compose start garage >/dev/null
recovered=0
for _attempt in $(seq 1 20); do
  if curl -fsS -o "$tmp_body" "http://127.0.0.1:${NAS_PUBLIC_PORT}/proxy-upload.txt" \
    && [ "$(cat "$tmp_body")" = "$part_body" ]; then
    recovered=1
    break
  fi
  sleep 1
done
[ "$recovered" -eq 1 ] || { echo "Garage did not recover through the proxy" >&2; exit 1; }

echo "Live Garage upload/public proxy semantics: OK"
