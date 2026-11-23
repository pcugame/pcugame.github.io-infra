#!/usr/bin/env python3
"""Parse Podman literal env files; deployment defaults are not adoption evidence."""
import re
import shlex
import sys
from pathlib import Path

COMMON_DEFAULTS = dict(LOG_LEVEL='info', FILE_GATEWAY_SECRET='', S3_REGION='garage',
    S3_BUCKET_PUBLIC='pcu-public', S3_BUCKET_PROTECTED='pcu-protected', S3_FORCE_PATH_STYLE='true',
    WEBGL_EXTERNAL_CONNECTIONS_ENABLED='false', WEBGL_PLAY_ENABLED='false')
API_DEFAULTS = dict(TRUST_PROXY='false', DOWNLOAD_AUTO_IP_BAN_ENABLED='false', SESSION_COOKIE_NAME='sid',
    SESSION_IDLE_MS='7200000', SESSION_ABSOLUTE_MS='1209600000', SESSION_TOUCH_MIN_INTERVAL_MS='300000',
    SHUTDOWN_DRAIN_MS='15000', COOKIE_SECURE='true', COOKIE_SAME_SITE='none', ALLOWED_GOOGLE_HD='')
COMMON_REQUIRED = set('''DATABASE_URL SESSION_SECRET GOOGLE_CLIENT_IDS CORS_ALLOWED_ORIGINS
API_PUBLIC_URL WEB_PUBLIC_URL S3_ENDPOINT S3_PUBLIC_SIGNING_ENDPOINT
S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT PUBLIC_ASSET_ORIGIN S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY
DIRECT_UPLOAD_PART_URL_REFRESH_MAX UPLOAD_USER_GAME_MAX_MB UPLOAD_PRIVILEGED_GAME_MAX_MB
DIRECT_UPLOAD_WORKER_TEMP_MAX_MB EXPORT_WORKER_MAX_OBJECT_BYTES EXPORT_WORKER_MAX_JOB_BYTES'''.split())
COMMON_OPTIONAL_KEYS = {'VIDEO_PLAYBACK_RENDITIONS_ENABLED'}
COMMON_KEYS = COMMON_REQUIRED | COMMON_DEFAULTS.keys() | COMMON_OPTIONAL_KEYS
API_OPTIONAL_KEYS = {'VOTE_INVESTIGATION_SECRET', 'VOTE_PRIVACY_NOTICE'}
API_KEYS = set(API_DEFAULTS) | API_OPTIONAL_KEYS
PG_KEYS = set('POSTGRES_USER POSTGRES_DB POSTGRES_PASSWORD'.split())
SCOPES = (COMMON_KEYS, API_KEYS, PG_KEYS)
# The private production forward has a fixed wire profile. The lab file is
# shared only by the API and benchmark worker; other workloads retain their scopes.
LAB_PROFILE = dict(LAB_ENABLED='true', LAB_MODEL_PROVIDER='transformers-generate',
    LAB_MODEL='Qwen3-4B-Instruct-2507-Q4_K_M', LAB_MODEL_URL='http://127.0.0.1:18088', LAB_CONCURRENCY='1')
LAB_SEARCH_URL = 'http://127.0.0.1:18888'
LAB_KEYS = {'DATABASE_URL', 'LAB_SEARXNG_URL', *LAB_PROFILE}


def read_runtime_files(filenames, *, explicit=False):
    """Return the deployment scopes, rejecting duplicates and unknown keys.

    Values remain literal, including quotes, dollar signs and equals signs. Shell text is never executed; callers must suppress OS exception messages
    because those can include operator filenames.
    """
    if len(filenames) not in (3, 4):
        raise ValueError()
    scopes = []
    for index, (filename, allowed) in enumerate(zip(filenames, (*SCOPES, LAB_KEYS))):
        values = {}
        for line in Path(filename).read_text().split('\n'):
            if not line.strip() or line.lstrip().startswith('#'):
                continue
            if line != line.strip() or any(ord(char) < 32 for char in line):
                raise ValueError()
            key, separator, value = line.partition('=')
            if not separator or not re.fullmatch('[A-Z][A-Z0-9_]*', key):
                raise ValueError()
            if key not in allowed or key in values:
                raise ValueError()
            values[key] = value
        required = allowed - (COMMON_OPTIONAL_KEYS if index == 0 else API_OPTIONAL_KEYS if index == 1 else set())
        if index == 3:
            required = required - {'LAB_SEARXNG_URL'}
        if explicit and not required <= values.keys():
            raise ValueError()
        scopes.append(values)
    if len(scopes) == 4:
        expected = LAB_PROFILE | {'DATABASE_URL': scopes[0].get('DATABASE_URL')}
        if 'LAB_SEARXNG_URL' in scopes[3]:
            expected['LAB_SEARXNG_URL'] = LAB_SEARCH_URL
        if not expected['DATABASE_URL'] or scopes[3] != expected:
            raise ValueError()
    return scopes


def deployment_values(filenames):
    scopes = read_runtime_files(filenames)
    common, api, postgres = scopes[:3]
    values = COMMON_DEFAULTS | API_DEFAULTS | common | api | postgres
    # Preserve the existing gate contract; adoption separately requires every
    # documented key, including POSTGRES_PASSWORD and defaulted values.
    required = COMMON_REQUIRED | {'FILE_GATEWAY_SECRET', 'TRUST_PROXY', 'POSTGRES_USER', 'POSTGRES_DB'}
    if not required <= values.keys():
        raise ValueError()
    if len(scopes) == 4:
        values['LAB_MODEL'] = scopes[3]['LAB_MODEL']
    return values


if __name__ == '__main__':
    try:
        for key, value in deployment_values(sys.argv[1:]).items():
            print('export ' + key + '=' + shlex.quote(value))
    except (OSError, ValueError, UnicodeError):
        print('ERROR: runtime env files must be readable literal KEY=value files with required runtime gate values and no deployment controls', file=sys.stderr)
        sys.exit(1)
