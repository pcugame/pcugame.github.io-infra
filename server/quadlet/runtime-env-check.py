#!/usr/bin/env python3
"""Read-only adoption comparison. Inspect JSON and private values stay in memory."""
import argparse
import json
from pathlib import Path
import re
import runpy
import sys
from urllib.parse import urlsplit

# run_path reuses the parser without importing a module or writing bytecode.
RUNTIME = runpy.run_path(str(Path(__file__).with_name('runtime-env.py')))
APP_NAMES = ('gp-api', 'gp-worker-game-validation', 'gp-worker-webgl',
             'gp-worker-video', 'gp-worker-image', 'gp-worker-export',
             'gp-worker-project-publication')
NAMES = APP_NAMES + ('gp-postgres',)
RESERVED = {'NODE_ENV', 'PORT', 'NAS_EXPORT_ROOT', 'NODE_EXTRA_CA_CERTS'}
# Fixed application key inventory: tests verify schema/direct-read coverage.
# The checker runs from deployment scripts without requiring application sources.
# Recognition does not authorize new keys in operator runtime env files.
APP_SCHEMA_KEYS = set("""
ALLOWED_GOOGLE_HD API_PUBLIC_URL COOKIE_SAME_SITE COOKIE_SECURE CORS_ALLOWED_ORIGINS
DATABASE_URL DEV_AUTH_ENABLED DIRECT_UPLOAD_PART_SIZE_MB DIRECT_UPLOAD_PART_URL_REFRESH_MAX DIRECT_UPLOAD_PART_URL_TTL_SEC
DIRECT_UPLOAD_WORKER_POLL_MS DIRECT_UPLOAD_WORKER_TEMP_MAX_MB DIRECT_UPLOAD_WORKER_TEMP_ROOT DOWNLOAD_AUTO_IP_BAN_ENABLED EXPORT_WORKER_FILE_CONCURRENCY
EXPORT_WORKER_LEASE_MS EXPORT_WORKER_MAX_JOB_BYTES EXPORT_WORKER_MAX_OBJECT_BYTES EXPORT_WORKER_POLL_MS EXPORT_WORKER_RETRY_BASE_MS
FILE_GATEWAY_SECRET GOOGLE_CLIENT_IDS IMAGE_WORKER_POLL_MS IMAGE_WORKER_TEMP_MAX_MB IMAGE_WORKER_TEMP_ROOT
LOG_LEVEL NAS_EXPORT_ROOT NODE_ENV PORT PUBLIC_ASSET_ORIGIN
RATE_LIMIT_GLOBAL_MAX RATE_LIMIT_GLOBAL_WINDOW_MS RATE_LIMIT_LOGIN_MAX RATE_LIMIT_LOGIN_WINDOW_MS RATE_LIMIT_SUBMIT_MAX
RATE_LIMIT_SUBMIT_WINDOW_MS S3_ACCESS_KEY_ID S3_BUCKET_PROTECTED S3_BUCKET_PUBLIC S3_ENDPOINT
S3_FORCE_PATH_STYLE S3_PRESIGN_TTL_SEC S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT S3_PUBLIC_SIGNING_ENDPOINT S3_REGION
S3_SECRET_ACCESS_KEY SESSION_ABSOLUTE_MS SESSION_COOKIE_NAME SESSION_IDLE_MS SESSION_SECRET
SESSION_TOUCH_MIN_INTERVAL_MS SHUTDOWN_DRAIN_MS TRUST_PROXY UPLOAD_CHUNKED_GAME_MAX_MB UPLOAD_CHUNK_SIZE_MB
UPLOAD_MAX_CONCURRENT UPLOAD_PRIVILEGED_GAME_MAX_MB UPLOAD_PRIVILEGED_IMAGE_MAX_MB UPLOAD_PRIVILEGED_MAX_FILES UPLOAD_PRIVILEGED_REQUEST_MAX_MB
UPLOAD_ROOT_PROTECTED UPLOAD_ROOT_PUBLIC UPLOAD_SESSION_TTL_MINUTES UPLOAD_USER_GAME_MAX_MB UPLOAD_USER_IMAGE_MAX_MB
UPLOAD_USER_MAX_FILES UPLOAD_USER_REQUEST_MAX_MB VIDEO_WORKER_POLL_MS VIDEO_WORKER_TEMP_DISK_MB VIDEO_WORKER_TEMP_ROOT
VOTE_INVESTIGATION_SECRET VOTE_PRIVACY_NOTICE
WEBGL_EXTERNAL_CONNECTIONS_ENABLED WEBGL_PLAY_ENABLED WEB_PUBLIC_URL
""".split())
# No additional direct process.env key reads currently exist in application source.
APP_PROCESS_ENV_KEYS = set()
KNOWN = set().union(*RUNTIME['SCOPES'], RESERVED, APP_SCHEMA_KEYS, APP_PROCESS_ENV_KEYS)
ERROR = 'ERROR: invalid runtime files, topology options, or running-container inspect input'


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError()
        result[key] = value
    return result


def reject_constant(value):
    raise ValueError()


def inspect_envs(document):
    if not isinstance(document, list) or len(document) != len(NAMES):
        raise ValueError()
    result = {}
    for item in document:
        if not isinstance(item, dict):
            raise ValueError()
        name = item.get('Name')
        if isinstance(name, str) and name.startswith('/'):
            name = name[1:]
        if name not in NAMES or name in result:
            raise ValueError()
        state, config = item.get('State'), item.get('Config')
        if not isinstance(state, dict) or state.get('Running') is not True or not isinstance(config, dict):
            raise ValueError()
        entries = config.get('Env')
        if not isinstance(entries, list):
            raise ValueError()
        values = {}
        for entry in entries:
            if not isinstance(entry, str) or '\0' in entry:
                raise ValueError()
            key, separator, value = entry.partition('=')
            if not separator or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key) or key in values:
                raise ValueError()
            # Image-inherited values (e.g. PostgreSQL's DOCKER_PG_LLVM_DEPS)
            # may be multiline. Only the compared runtime inventory must fit
            # literal one-line env files; do not certify unrelated image values.
            if key in KNOWN and any(ord(char) < 32 for char in value):
                raise ValueError()
            values[key] = value
        result[name] = values
    return result


def postgres_loopback_equivalent(expected, actual):
    """Only substitute the raw hostname; all credential/port/path bytes must match."""
    try:
        url = urlsplit(expected)
        if url.scheme not in ('postgres', 'postgresql') or url.hostname != 'postgres':
            return False
        authority = url.netloc
        prefix, separator, hostport = authority.rpartition('@')
        if not separator:
            prefix, hostport = '', authority
        if hostport != 'postgres' and not hostport.startswith('postgres:'):
            return False
        # Validate malformed ports before granting the special status.
        url.port
        replacement = (prefix + '@' if separator else '') + '127.0.0.1' + hostport[len('postgres'):]
        start = expected.index('//') + 2
        transformed = expected[:start] + replacement + expected[start + len(authority):]
        return transformed == actual
    except (ValueError, UnicodeError):
        return False


def compare(scopes, actual, nas_root, garage_ca):
    common, api, postgres = scopes
    rows, matched = [], True
    for name in NAMES:
        expected = dict(postgres) if name == 'gp-postgres' else common | {'NODE_ENV': 'production'}
        if name == 'gp-api':
            expected.update(api | {'PORT': '4000'})
        if name == 'gp-worker-export':
            expected['NAS_EXPORT_ROOT'] = nas_root
        if name in APP_NAMES and garage_ca:
            expected['NODE_EXTRA_CA_CERTS'] = '/run/secrets/garage-ca.pem'
        for key in sorted(expected):
            if key not in actual[name]:
                status = 'missing'
            elif expected[key] == actual[name][key]:
                status = 'equal'
            elif key == 'DATABASE_URL' and postgres_loopback_equivalent(expected[key], actual[name][key]):
                status = 'postgres-loopback-equivalent'
            else:
                status = 'different'
            matched &= status in ('equal', 'postgres-loopback-equivalent')
            rows.append(f'{name} {key} {status}')
        for key in sorted((KNOWN - expected.keys()) & actual[name].keys()):
            matched = False
            rows.append(f'{name} {key} unexpected')
        # Reserved absence is structural evidence too, especially optional CA.
        for key in sorted(RESERVED - expected.keys() - actual[name].keys()):
            rows.append(f'{name} {key} absent')
    return rows, matched


def main():
    parser = SafeParser(description=__doc__)
    parser.add_argument('common')
    parser.add_argument('api')
    parser.add_argument('postgres')
    parser.add_argument('--nas-export-root', default='/nas')
    parser.add_argument('--garage-ca', action='store_true')
    options = parser.parse_args()
    root = options.nas_export_root
    if not root.startswith('/') or any(c in root for c in ':\\\n\r\0') or root != root.strip():
        raise ValueError()
    scopes = RUNTIME['read_runtime_files']((options.common, options.api, options.postgres), explicit=True)
    actual = inspect_envs(json.load(sys.stdin, object_pairs_hook=unique_object, parse_constant=reject_constant))
    rows, matched = compare(scopes, actual, root, options.garage_ca)
    print('\n'.join(rows))
    print('DATABASE_URL comparison is structural only; database connectivity is unverified')
    return 0 if matched else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, UnicodeError, TypeError, KeyError, RecursionError):
        # Never render input, exception messages, unknown names, or tracebacks.
        print(ERROR, file=sys.stderr)
        sys.exit(2)
