#!/usr/bin/env python3
"""Build an owned minimal project with pinned official Godot, never run uploaded code.

GODOT_RUNNER=steam-run supports NixOS; its work directory must be outside /tmp.
The resulting external/embedded packs are real exports, not hand-written headers.
"""
import hashlib
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import urllib.request
import zipfile

tools = {
    'linux_headless.64.zip': ('6590e8fe75695dfb1b70b45856116733aa484336b820c75082b7f7c645ca8259', 'Godot_v3.6.2-stable_linux_headless.64'),
    'export_templates.tpz': ('41bdd00ac3141fc50f8eb261d4cf6f25c46dba6abb2401dfe49b39cba555898e', 'templates/linux_x11_64_release'),
}
work = Path(os.environ.get('GODOT_EXPORT_WORK_ROOT', str(Path.home() / '.cache/pcu-godot-fixture'))).resolve()
output = Path(os.environ.get('NATIVE_FIXTURE_ROOT', '/tmp/pcu-build-native')).resolve()
work.mkdir(parents=True, exist_ok=True)
output.mkdir(parents=True, exist_ok=True)
for flavor, (digest, member) in tools.items():
    archive = work / ('Godot_v3.6.2-stable_' + flavor)
    if not archive.exists():
        urllib.request.urlretrieve('https://github.com/godotengine/godot-builds/releases/download/3.6.2-stable/' + archive.name, archive)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != digest:
        raise RuntimeError('Official Godot checksum mismatch: ' + flavor)
    target = work / Path(member).name
    with zipfile.ZipFile(archive) as z:
        target.write_bytes(z.read(member))
    target.chmod(0o700)

project = work / 'project'
shutil.copytree(Path(__file__).with_name('godot-native'), project, dirs_exist_ok=True)
runner = shlex.split(os.environ.get('GODOT_RUNNER', ''))
for embedded in [False, True]:
    label = 'godot-generated-' + ('embedded' if embedded else 'external')
    target = work / label
    target.mkdir(exist_ok=True)
    (project / 'export_presets.cfg').write_text(f'''[preset.0]
name="Linux"
platform="Linux/X11"
runnable=true
export_filter="all_resources"
include_filter=""
exclude_filter=""
export_path=""
script_export_mode=1

[preset.0.options]
custom_template/debug="{work / 'linux_x11_64_release'}"
custom_template/release="{work / 'linux_x11_64_release'}"
binary_format/64_bits=true
binary_format/embed_pck={str(embedded).lower()}
''')
    subprocess.run(runner + [str(work / 'Godot_v3.6.2-stable_linux_headless.64'), '--path', str(project), '--export', 'Linux', str(target / 'Game.x86_64')], check=True)
    with zipfile.ZipFile(output / (label + '.zip'), 'w', zipfile.ZIP_DEFLATED) as z:
        for path in sorted(target.iterdir()):
            z.write(path, '한글 빌드/' + path.name)
    print(label)
