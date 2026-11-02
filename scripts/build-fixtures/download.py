#!/usr/bin/env python3
"""Fetch pinned actual exports to temporary storage; no third-party game code is executed.
Run with catalog names, e.g. download.py playcanvas defold construct rpgmaker gdevelop-red cocos.
Upstream licenses apply. Fixtures are not redistributed in this repository.
"""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.request
import zipfile

root = Path(os.environ.get('ENGINE_FIXTURE_ROOT', '/tmp/pcu-build-exports'))
for name in sys.argv[1:]:
    catalog = json.loads(Path(__file__).with_name(name + '.json').read_text())
    directory = root / name
    def fetch(record):
        path = directory / record['path']
        path.parent.mkdir(parents=True, exist_ok=True)
        body = path.read_bytes() if path.exists() else urllib.request.urlopen(record['url'], timeout=120).read()
        if len(body) != record['size'] or hashlib.sha256(body).hexdigest() != record['sha256']:
            raise RuntimeError(f"Fixture provenance mismatch: {name}/{record['path']}")
        path.write_bytes(body)
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(fetch, catalog['files']))
    for variant, prefix, entry in [('root', '', 'index.html'), ('custom', 'one/two/한글 배포/', 'game.html')]:
        archive = root / f'{name}{"" if variant == "root" else "-custom"}.zip'
        with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as output:
            for record in catalog['files']:
                target = entry if record['path'] == 'index.html' else record['path']
                output.write(directory / record['path'], prefix + target)
        print(archive)
