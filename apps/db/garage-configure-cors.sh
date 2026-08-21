#!/bin/sh
# Configure exact-origin bucket CORS through Garage's standard S3 API. Garage
# v1.1 has no bucket-CORS admin CLI; PutBucketCors/GetBucketCors is the
# supported data-plane interface and is reachable only from the init job.
set -eu

: "${S3_INTERNAL_ENDPOINT:?S3_INTERNAL_ENDPOINT is required}"
: "${S3_ACCESS_KEY_ID:?S3_ACCESS_KEY_ID is required}"
: "${S3_SECRET_ACCESS_KEY:?S3_SECRET_ACCESS_KEY is required}"
: "${S3_CORS_ALLOWED_ORIGINS:?S3_CORS_ALLOWED_ORIGINS is required}"

policy_kind=${1:?usage: garage-configure-cors protected|public bucket}
bucket=${2:?usage: garage-configure-cors protected|public bucket}

case "$policy_kind" in
  protected)
    allowed_methods='["PUT", "HEAD"]'
    allowed_headers='["content-type", "x-amz-content-sha256", "x-amz-date", "x-amz-security-token", "x-amz-user-agent", "x-amz-checksum-crc32", "x-amz-checksum-crc32c", "x-amz-checksum-sha1", "x-amz-checksum-sha256"]'
    expose_headers='["ETag"]'
    ;;
  public)
    allowed_methods='["GET", "HEAD"]'
    allowed_headers='["Range", "If-Range", "If-None-Match", "If-Modified-Since"]'
    expose_headers='["ETag", "Last-Modified", "Content-Length", "Content-Range", "Content-Encoding"]'
    ;;
  *)
    echo "unknown Garage CORS policy: $policy_kind" >&2
    exit 64
    ;;
esac

expected_file=$(mktemp)
actual_file=$(mktemp)
trap 'rm -f "$expected_file" "$actual_file"' EXIT

# Origins are a deployment value, never an interpolation into shell/JSON. A
# browser only accepts a single exact Allow-Origin; emit one rule per origin.
S3_CORS_ALLOWED_ORIGINS="$S3_CORS_ALLOWED_ORIGINS" \
ALLOWED_METHODS="$allowed_methods" \
ALLOWED_HEADERS="$allowed_headers" \
EXPOSE_HEADERS="$expose_headers" \
python3 - "$expected_file" <<'PY'
import json
import os
import sys
from urllib.parse import urlsplit

def normalize_origin(raw: str) -> str:
    origin = raw.strip()
    if not origin:
        raise ValueError('origins must not be empty')
    if '*' in origin:
        raise ValueError('wildcards are not allowed')
    try:
        parsed = urlsplit(origin)
        port = parsed.port
    except ValueError as error:
        raise ValueError('has an invalid port') from error
    scheme = parsed.scheme.lower()
    if scheme not in ('http', 'https'):
        raise ValueError('must use http or https')
    if not parsed.hostname:
        raise ValueError('must include a host')
    if parsed.username is not None or parsed.password is not None:
        raise ValueError('must not include credentials')
    if parsed.query or parsed.fragment:
        raise ValueError('must not include a query or fragment')
    if parsed.path not in ('', '/'):
        raise ValueError('must not include a path')
    if parsed.netloc.endswith(':'):
        raise ValueError('has an invalid empty port')
    try:
        host = parsed.hostname.encode('idna').decode('ascii').lower()
    except UnicodeError as error:
        raise ValueError('has an invalid host') from error
    if ':' in host and not host.startswith('['):
        host = f'[{host}]'
    default_port = (scheme == 'http' and port == 80) or (scheme == 'https' and port == 443)
    suffix = '' if port is None or default_port else f':{port}'
    return f'{scheme}://{host}{suffix}'

try:
    origins = [normalize_origin(raw) for raw in os.environ['S3_CORS_ALLOWED_ORIGINS'].split(',')]
except ValueError as error:
    raise SystemExit(f'S3_CORS_ALLOWED_ORIGINS contains an invalid origin: {error}') from error
origins = list(dict.fromkeys(origins))
if not origins:
    raise SystemExit('S3_CORS_ALLOWED_ORIGINS must contain at least one origin')

rule = {
    'AllowedMethods': json.loads(os.environ['ALLOWED_METHODS']),
    'AllowedHeaders': json.loads(os.environ['ALLOWED_HEADERS']),
    'ExposeHeaders': json.loads(os.environ['EXPOSE_HEADERS']),
    'MaxAgeSeconds': 300,
}
json.dump({'CORSRules': [dict(rule, AllowedOrigins=[origin]) for origin in origins]}, open(sys.argv[1], 'w'))
PY

export AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="${S3_REGION:-garage}"
export AWS_EC2_METADATA_DISABLED=true
export AWS_PAGER=""

# Put is a full desired-state replacement, so re-running the init job converges
# without accumulating rules. Read it back and compare it to fail closed if
# Garage stops persisting or serving the expected policy.
aws --no-cli-pager --endpoint-url "$S3_INTERNAL_ENDPOINT" \
  s3api put-bucket-cors --bucket "$bucket" --cors-configuration "file://$expected_file"
aws --no-cli-pager --endpoint-url "$S3_INTERNAL_ENDPOINT" \
  s3api get-bucket-cors --bucket "$bucket" >"$actual_file"
python3 - "$expected_file" "$actual_file" <<'PY'
import json
import sys

with open(sys.argv[1]) as expected_file, open(sys.argv[2]) as actual_file:
    expected = json.load(expected_file)
    actual = json.load(actual_file)
if actual != expected:
    raise SystemExit('Garage GetBucketCors did not return the policy just applied')
PY
