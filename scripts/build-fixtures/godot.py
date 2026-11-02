#!/usr/bin/env python3
"""Download only pinned official Godot export bytes; create local acceptance ZIPs."""
import hashlib
import json
import os
from pathlib import Path
import urllib.request
import zipfile

catalog = json.loads(Path(__file__).with_name('godot-pong.json').read_text())
root = Path(os.environ.get('GODOT_FIXTURE_ROOT', '/tmp/pcu-build-godot'))
root.mkdir(parents=True, exist_ok=True)
for record in catalog['files']:
    path = root / record['path']
    body = path.read_bytes() if path.exists() else urllib.request.urlopen(record['url'], timeout=120).read()
    if len(body) != record['bytes'] or hashlib.sha256(body).hexdigest() != record['sha256']:
        raise RuntimeError(f"Fixture provenance mismatch: {record['path']}")
    path.write_bytes(body)
for name, prefix, html in [('root', '', 'index.html'), ('custom', 'one/two/한글 배포/', 'game.html')]:
    archive = root / f'godot-pong-{name}.zip'
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as target:
        for record in catalog['files']:
            target.write(root / record['path'], prefix + (html if record['path'] == 'index.html' else record['path']))
    print(archive)
