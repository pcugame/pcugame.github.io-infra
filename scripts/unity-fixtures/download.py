#!/usr/bin/env python3
"""Download checksum-pinned real exports; never execute third-party tooling."""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import urllib.request
import zipfile

catalog = json.loads((Path(__file__).parent / 'catalog.json').read_text())
root = Path(os.environ.get('FIXTURE_ROOT', '/tmp/pcu-unity-fixture-repro')).resolve()
root.mkdir(parents=True, exist_ok=True)
archives = []
for fixture in catalog['fixtures']:
    destination = root / 'sources' / fixture['name']
    def fetch(item):
        relative = Path(item['path'])
        if relative.is_absolute() or '..' in relative.parts:
            raise ValueError('Unsafe catalog destination')
        data = urllib.request.urlopen(item['url'], timeout=60).read()
        if len(data) != item['size'] or hashlib.sha256(data).hexdigest() != item['sha256']:
            raise ValueError('Fixture checksum mismatch: ' + item['url'])
        output = destination / relative
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(data)
    list(concurrent.futures.ThreadPoolExecutor(max_workers=6).map(fetch, fixture['files']))
    for wrapper in ['', 'UnityBuild/']:
        archive = root / (fixture['name'] + ('-wrapper' if wrapper else '-root') + '.zip')
        with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_STORED) as output:
            for item in fixture['files']:
                entry = zipfile.ZipInfo(wrapper + item['path'], date_time=(2026, 1, 1, 0, 0, 0))
                entry.compress_type = zipfile.ZIP_STORED
                output.writestr(entry, (destination / item['path']).read_bytes())
        archives.append({'path': str(archive), 'size': archive.stat().st_size,
                         'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()})
    print(fixture['name'], len(fixture['files']), 'verified files', flush=True)
(root / 'all-archive-manifest.json').write_text(json.dumps(archives, indent=2) + '\n')
(root / 'source-catalog.json').write_text(json.dumps(catalog, indent=2) + '\n')
