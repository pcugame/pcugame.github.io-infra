#!/usr/bin/env python3
"""Render topology only; operator runtime env files are opaque external inputs."""
import os
from pathlib import Path
import re
import sys

# This is the complete environment interface. Runtime configuration is never read.
DEFAULTS = {
    'API_IMAGE': '', 'DEPLOY_DIR': '/srv/graduationproject_v2',
    'API_BIND_HOST': '127.0.0.1', 'API_PORT': '4000',
    'NAS_EXPORT_HOST_PATH': '/mnt/nas/pcu_storage/GraduationGame', 'NAS_EXPORT_PATH': '/nas',
    'S3_TLS_CA_HOST_PATH': '', 'APP_RUNTIME_ENV_FILE': '',
    'API_RUNTIME_ENV_FILE': '', 'POSTGRES_RUNTIME_ENV_FILE': '',
}


def quote(text):
    return '"' + escape(text).replace('\\', '\\\\').replace('"', '\\"') + '"'


def escape(text):
    return text.replace('%', '%%').replace('$', '$$')


def render(output):
    settings = {name: os.environ.get(name) or default for name, default in DEFAULTS.items()}
    if any('\n' in item or '\r' in item or '\0' in item for item in settings.values()):
        raise ValueError('topology settings must be single-line values')
    image = settings['API_IMAGE']
    if not re.fullmatch(r'ghcr\.io/pcugame/pcu-graduationproject-v2-api@sha256:[0-9a-f]{64}', image):
        raise ValueError('API_IMAGE must be an immutable digest in the authorized release repository')
    deploy = settings['DEPLOY_DIR']
    common = settings['APP_RUNTIME_ENV_FILE'] or deploy + '/runtime-env/common.env'
    api = settings['API_RUNTIME_ENV_FILE'] or deploy + '/runtime-env/api.env'
    postgres = settings['POSTGRES_RUNTIME_ENV_FILE'] or deploy + '/runtime-env/postgres.env'
    nas_host, nas_path, ca_host = (settings[name] for name in ('NAS_EXPORT_HOST_PATH', 'NAS_EXPORT_PATH', 'S3_TLS_CA_HOST_PATH'))
    paths = [str(output), deploy, common, api, postgres, nas_host, nas_path] + ([ca_host] if ca_host else [])
    if any(not path.startswith('/') or ':' in path or '\\' in path or '\n' in path or '\r' in path or path != path.strip() for path in paths):
        raise ValueError('topology paths must be absolute without colon, backslash, or edge whitespace')
    if len({common, api, postgres}) != 3:
        raise ValueError('common, API, and PostgreSQL runtime env paths must be distinct')
    host, port = settings['API_BIND_HOST'], settings['API_PORT']
    if not re.fullmatch(r'[A-Za-z0-9_.-]+|\[[0-9A-Fa-f:]+\]', host):
        raise ValueError('API_BIND_HOST must be a host address or bracketed IPv6 address')
    if not port.isascii() or not port.isdecimal() or not 1 <= int(port) <= 65535:
        raise ValueError('API_PORT must be between 1 and 65535')
    tokens = {
        'NETWORK_READY': quote(deploy + '/runtime-helpers/wait-network-ready.py'),
        'API_IMAGE': image, 'API_PUBLISH': escape(f'{host}:{port}:4000'),
        'COMMON_ENV': quote(common), 'API_ENV': quote(api), 'POSTGRES_ENV': quote(postgres),
        'EXPORT_ENV': 'Environment=' + quote('NAS_EXPORT_ROOT=' + nas_path),
        'NAS_VOLUME': escape(f'{nas_host}:{nas_path}:rw,Z'),
        'CA_VOLUME': 'Volume=' + escape(f'{ca_host}:/run/secrets/garage-ca.pem:ro,Z') if ca_host else '',
        'CA_ENV': 'Environment=NODE_EXTRA_CA_CERTS=/run/secrets/garage-ca.pem' if ca_host else '',
    }
    templates = Path(__file__).parent / 'templates'
    rendered = {
        template.name.removesuffix('.in'): re.sub(r'@([A-Z_]+)@', lambda match: tokens[match[1]], template.read_text())
        for template in templates.glob('*.in')
    }
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    for filename, content in rendered.items():
        path = output / filename
        path.write_text(content)
        path.chmod(0o600)


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('expected one new output directory')
        render(Path(sys.argv[1]).absolute())
    except (ValueError, OSError):
        # Values and exception paths may contain private information; never echo them.
        print('Quadlet rendering failed: invalid topology, immutable digest, or output directory', file=sys.stderr)
        sys.exit(1)
