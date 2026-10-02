#!/usr/bin/env python3
"""Read Podman literal env-file assignments for gates; never execute shell text."""
import re
import shlex
import sys
from pathlib import Path

try:
    if len(sys.argv) != 4:
        raise ValueError()
    common_defaults = dict(LOG_LEVEL='info', FILE_GATEWAY_SECRET='', S3_REGION='garage',
        S3_BUCKET_PUBLIC='pcu-public', S3_BUCKET_PROTECTED='pcu-protected', S3_FORCE_PATH_STYLE='true',
        WEBGL_EXTERNAL_CONNECTIONS_ENABLED='false', WEBGL_PLAY_ENABLED='false')
    api_defaults = dict(TRUST_PROXY='false', DOWNLOAD_AUTO_IP_BAN_ENABLED='false', SESSION_COOKIE_NAME='sid',
        SESSION_IDLE_MS='7200000', SESSION_ABSOLUTE_MS='1209600000', SESSION_TOUCH_MIN_INTERVAL_MS='300000',
        SHUTDOWN_DRAIN_MS='15000', COOKIE_SECURE='true', COOKIE_SAME_SITE='none', ALLOWED_GOOGLE_HD='')
    common_required = set("DATABASE_URL SESSION_SECRET GOOGLE_CLIENT_IDS CORS_ALLOWED_ORIGINS API_PUBLIC_URL WEB_PUBLIC_URL S3_ENDPOINT S3_PUBLIC_SIGNING_ENDPOINT S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT PUBLIC_ASSET_ORIGIN S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY DIRECT_UPLOAD_PART_URL_REFRESH_MAX UPLOAD_USER_GAME_MAX_MB UPLOAD_PRIVILEGED_GAME_MAX_MB DIRECT_UPLOAD_WORKER_TEMP_MAX_MB EXPORT_WORKER_MAX_OBJECT_BYTES EXPORT_WORKER_MAX_JOB_BYTES".split())
    values = {}
    api_keys = set("TRUST_PROXY DOWNLOAD_AUTO_IP_BAN_ENABLED SESSION_COOKIE_NAME SESSION_IDLE_MS SESSION_ABSOLUTE_MS SESSION_TOUCH_MIN_INTERVAL_MS SHUTDOWN_DRAIN_MS COOKIE_SECURE COOKIE_SAME_SITE ALLOWED_GOOGLE_HD".split())
    pg_keys = set("POSTGRES_USER POSTGRES_DB POSTGRES_PASSWORD".split())
    for scope, filename in enumerate(sys.argv[1:]):
        for line in Path(filename).read_text().split('\n'):
            if not line.strip() or line.lstrip().startswith('#'):
                continue
            if line != line.strip() or any(ord(char) < 32 for char in line):
                raise ValueError()
            key, separator, value = line.partition('=')
            if not separator or not re.fullmatch('[A-Z][A-Z0-9_]*', key) or '\0' in value:
                raise ValueError()
            if (scope == 0 and key not in common_required | common_defaults.keys()) or (scope == 1 and key not in api_keys) or (scope == 2 and key not in pg_keys) or key in values:
                raise ValueError()
            values[key] = value
    values = common_defaults | api_defaults | values
    required = '''DATABASE_URL SESSION_SECRET GOOGLE_CLIENT_IDS CORS_ALLOWED_ORIGINS API_PUBLIC_URL WEB_PUBLIC_URL S3_ENDPOINT S3_PUBLIC_SIGNING_ENDPOINT S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT PUBLIC_ASSET_ORIGIN S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY FILE_GATEWAY_SECRET DIRECT_UPLOAD_PART_URL_REFRESH_MAX UPLOAD_USER_GAME_MAX_MB UPLOAD_PRIVILEGED_GAME_MAX_MB DIRECT_UPLOAD_WORKER_TEMP_MAX_MB EXPORT_WORKER_MAX_OBJECT_BYTES EXPORT_WORKER_MAX_JOB_BYTES TRUST_PROXY POSTGRES_USER POSTGRES_DB'''.split()
    if any(key not in values for key in required):
        raise ValueError()
    for key, value in values.items():
        print('export ' + key + '=' + shlex.quote(value))
except (OSError, ValueError, UnicodeError):
    print('ERROR: runtime env files must be readable literal KEY=value files with required runtime gate values and no deployment controls', file=sys.stderr)
    sys.exit(1)
