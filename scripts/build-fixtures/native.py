#!/usr/bin/env python3
"""Download pinned native exports without installing or executing them."""
import hashlib
import json
import os
from pathlib import Path
import urllib.request
import zipfile
root = Path(os.environ.get('NATIVE_FIXTURE_ROOT', '/tmp/pcu-build-native'))
root.mkdir(parents=True, exist_ok=True)
for record in json.loads(Path(__file__).with_name('native.json').read_text()):
    target = root / (record['name'] + ('.apk' if record.get('wrap') else '.zip'))
    body = target.read_bytes() if target.exists() else urllib.request.urlopen(record['url'], timeout=180).read()
    if len(body) != record['size'] or hashlib.sha256(body).hexdigest() != record['sha256']:
        raise RuntimeError('Fixture provenance mismatch: ' + record['name'])
    target.write_bytes(body)
    if record.get('wrap'):
        with zipfile.ZipFile(root / (record['name'] + '.zip'), 'w', zipfile.ZIP_DEFLATED) as z:
            z.writestr(record['wrap'], body)
    print(record['name'])
