#!/usr/bin/env python3
"""Prepare pinned real exports. Only the trusted 7zz utility runs, never game code."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import urllib.request
import zipfile

root = Path(os.environ.get('UE_FIXTURE_ROOT', '/tmp/pcu-ue-exports'))
root.mkdir(parents=True, exist_ok=True)
for record in json.loads(Path(__file__).with_name('unreal.json').read_text()):
    extension = '.7z' if record['url'].endswith('.7z') else '.zip'
    target = root / (record['name'] + extension)
    if not target.exists():
        with urllib.request.urlopen(record['url'], timeout=180) as response, target.open('wb') as output:
            shutil.copyfileobj(response, output)
    with target.open('rb') as source:
        digest = hashlib.file_digest(source, 'sha256').hexdigest()
    if target.stat().st_size != record['size'] or digest != record['sha256']:
        raise RuntimeError('UE fixture provenance mismatch: ' + record['name'])
    if extension == '.7z':
        directory = root / record['name']
        directory.mkdir(exist_ok=True)
        subprocess.run([os.environ.get('UE_7ZZ', '7zz'), 'x', str(target), '-o' + str(directory), '-y'], check=True, stdout=subprocess.DEVNULL)
        with zipfile.ZipFile(root / (record['name'] + '.zip'), 'w', zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(directory.rglob('*')):
                if path.is_file():
                    archive.write(path, str(path.relative_to(directory)))
    print(root / (record['name'] + '.zip'))
