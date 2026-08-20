#!/bin/sh
# Configure direct-browser multipart CORS through Garage's standard S3 API.
# This deliberately is not an application/Fastify proxy concern.
set -eu

: "${S3_INTERNAL_ENDPOINT:?S3_INTERNAL_ENDPOINT is required}"
: "${S3_ACCESS_KEY_ID:?S3_ACCESS_KEY_ID is required}"
: "${S3_SECRET_ACCESS_KEY:?S3_SECRET_ACCESS_KEY is required}"
: "${S3_CORS_ALLOWED_ORIGINS:?S3_CORS_ALLOWED_ORIGINS is required}"

cors_file=$(mktemp)
trap 'rm -f "$cors_file"' EXIT

# Origins are supplied as a comma-separated deployment value. The init image
# generates JSON rather than interpolating a URL into a shell/JSON literal.
S3_CORS_ALLOWED_ORIGINS="$S3_CORS_ALLOWED_ORIGINS" python3 - "$cors_file" <<'PY'
import json
import os
import sys
from urllib.parse import urlsplit

def normalize_origin(raw):
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
    if parsed.scheme.lower() not in ('http', 'https'):
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
    # URL.origin elides default ports; match browser Origin serialization.
    if ':' in host and not host.startswith('['):
        host = f'[{host}]'
    normalized_port = '' if port is None or (parsed.scheme.lower() == 'http' and port == 80) \
        or (parsed.scheme.lower() == 'https' and port == 443) else f':{port}'
    return f'{parsed.scheme.lower()}://{host}{normalized_port}'

raw_origins = os.environ['S3_CORS_ALLOWED_ORIGINS'].split(',')
try:
    origins = [normalize_origin(origin) for origin in raw_origins]
except ValueError as error:
    raise SystemExit(f'S3_CORS_ALLOWED_ORIGINS contains an invalid origin: {error}') from error
if not origins:
    raise SystemExit('S3_CORS_ALLOWED_ORIGINS must contain at least one origin')
origins = list(dict.fromkeys(origins))

rule_template = {
        'AllowedMethods': ['PUT', 'HEAD'],
        'AllowedHeaders': [
            'content-type',
            'x-amz-content-sha256',
            'x-amz-date',
            'x-amz-security-token',
            'x-amz-user-agent',
        ],
        'ExposeHeaders': ['ETag'],
        'MaxAgeSeconds': 300,
}
# Garage 1.1 writes a comma-joined Allow-Origin when several origins share one
# rule. A browser requires a single matching origin, so emit one S3 rule each.
json.dump({
    'CORSRules': [dict(rule_template, AllowedOrigins=[origin]) for origin in origins],
}, open(sys.argv[1], 'w'))
PY

export AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="${S3_REGION:-garage}"
export AWS_EC2_METADATA_DISABLED=true

for bucket in "$@"; do
  echo "=== Garage init: configuring direct-upload CORS for $bucket ==="
  aws --no-cli-pager --endpoint-url "$S3_INTERNAL_ENDPOINT" \
    s3api put-bucket-cors --bucket "$bucket" --cors-configuration "file://$cors_file"
  # Read it back so an unsupported/non-persistent S3 CORS implementation fails
  # initialization instead of silently breaking browser direct uploads.
  aws --no-cli-pager --endpoint-url "$S3_INTERNAL_ENDPOINT" \
    s3api get-bucket-cors --bucket "$bucket" >/dev/null
done
