#!/usr/bin/env python3
"""Offline renderer for separately adopted image infrastructure (no secrets read)."""
import runpy
import os
from pathlib import Path
import re
import sys

topology = runpy.run_path(str(Path(__file__).with_name('render.py')))


def render(output):
    deploy = os.environ.get('DEPLOY_DIR') or '/srv/graduationproject_v2'
    image_env = os.environ.get('IMAGE_RUNTIME_ENV_FILE') or deploy + '/runtime-env/imgproxy.env'
    ca = os.environ.get('S3_TLS_CA_HOST_PATH') or ''
    paths = [str(output), deploy, image_env] + ([ca] if ca else [])
    if any(not p.startswith('/') or any(c in p for c in ':\\\r\n\0') or p != p.strip() for p in paths):
        raise ValueError('invalid image topology path')
    config = deploy + '/image-cache.conf'
    tokens = {
        'IMAGE_ENV': topology['quote'](image_env), 'CACHE_CONFIG': topology['escape'](config),
        'CA_VOLUME': 'Volume=' + topology['escape'](ca + ':/run/secrets/garage-ca.pem:ro,Z') if ca else '',
        'CA_ENV': 'Environment=SSL_CERT_FILE=/run/secrets/garage-ca.pem' if ca else '',
    }
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    for template in Path(__file__).with_name('image-templates').glob('*.in'):
        content = re.sub(r'@([A-Z_]+)@', lambda m: tokens[m[1]], template.read_text())
        path = output / template.name.removesuffix('.in')
        path.write_text(content)
        path.chmod(0o600)
    config_text = (Path(__file__).parents[2] / 'apps/db/image-cache.nginx.conf.template').read_text()
    config_text = config_text.replace('${IMGPROXY_UPSTREAM}', 'http://127.0.0.1:8090').replace('listen 8081;', 'listen 127.0.0.1:8091;')
    (output / 'image-cache.conf').write_text(config_text)
    (output / 'image-cache.conf').chmod(0o600)


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('expected new output directory')
        render(Path(sys.argv[1]))
    except (ValueError, OSError):
        print('Image topology rendering failed', file=sys.stderr)
        sys.exit(1)
