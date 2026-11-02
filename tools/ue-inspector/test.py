#!/usr/bin/env python3
"""Protocol and confirmed damage checks. Synthetic envelopes do not certify exports."""
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile

binary = str(Path(sys.argv[1]).resolve())
revision = '605672df7a993a90094bad92d30c388d87ae6c1a'
def inspect(root, payloads):
    files = []
    for index, (name, data) in enumerate(payloads.items()):
        path = root / str(index)
        path.write_bytes(data)
        files.append(dict(path=name, localPath=str(path), bytes=len(data)))
    request = root / 'request.json'
    request.write_text(json.dumps(dict(version=1, analysisBytes=32*1024**2, files=files)))
    result = subprocess.run([binary, str(request)], capture_output=True, timeout=60, check=True)
    assert len(result.stdout) + len(result.stderr) <= 1024**2
    output = json.loads(result.stdout)
    assert output['version'] == 1 and output['parserRevision'] == revision
    return output['facts']
def pak(mount='../../../Project/', offset=None, bad_hash=False):
    encoded = mount.encode() + b'\0'
    index = struct.pack('<i', len(encoded)) + encoded + struct.pack('<i', 0)
    digest = hashlib.sha1(index).digest() if not bad_hash else bytes(20)
    footer = bytes(17) + struct.pack('<IIqq', 0x5a6f12e1, 3, len(index)+100 if offset else 0, len(index)) + digest
    return index + footer
with tempfile.TemporaryDirectory(prefix='pcu-ue-inspector-test-') as directory:
    root = Path(directory)
    for payload, reason, status in [
        (pak(), 'ue-pak-cooked-payload-not-certified', 'review'),
        (pak(bad_hash=True), 'ue-pak-index-hash-mismatch', 'reject'),
        (pak(offset=True), 'ue-range-outside-file', 'reject'),
        (pak('../../../../escape/'), 'ue-virtual-path-escape', 'reject'),
        (b'custom container', 'ue-parser-unsupported-or-inconclusive', 'review'),
    ]:
        fact = inspect(root, {'프로젝트/game.pak': payload})[0]
        assert fact['status'] == status and reason in fact['reasons'], fact
    # A known standard UTOC header explicitly declares a missing partition.
    header = bytearray(144)
    header[:16] = b'-==--==--==--==-'
    header[16] = 5
    struct.pack_into('<I', header, 20, 144)
    struct.pack_into('<I', header, 32, 12)
    struct.pack_into('<I', header, 44, 65536)
    struct.pack_into('<I', header, 52, 1)
    struct.pack_into('<Q', header, 88, 2**40)
    fact = inspect(root, {'Project/main.utoc': header})[0]
    assert fact['status'] == 'reject' and 'ue-missing-ucas-partition' in fact['reasons'], fact
    loose = struct.pack('<Iiiii', 0x9e2a83c1, -7, 0, 522, 0)
    fact = inspect(root, {'Project/test.uasset': loose})[0]
    assert fact['status'] == 'review' and 'ue-loose-version-not-certified' in fact['reasons'], fact
    request = root / 'invalid.json'
    request.write_text('{"version":2}')
    invalid = subprocess.run([binary, str(request)], capture_output=True, timeout=60)
    assert invalid.returncode != 0 and not invalid.stdout
print('UE inspector: 8 protocol/range/hash/mount/partition/version-gate checks passed (no automatic export certification)')

# Optional independently downloaded real export. This still does not certify PASS.
if len(sys.argv) > 2:
    actual = Path(sys.argv[2]).resolve()
    original = next(actual.rglob('TanksUnreal_v2-Linux.pak')).read_bytes()
    magic = original.rfind(struct.pack('<I', 0x5a6f12e1), max(0, len(original)-512))
    assert magic >= 0
    version, index_offset, index_size = struct.unpack_from('<Iqq', original, magic+4)
    assert version == 11
    altered = bytearray(original)
    altered[index_offset] ^= 1
    outside = bytearray(original)
    struct.pack_into('<q', outside, magic+8, len(outside)+100)
    with tempfile.TemporaryDirectory(prefix='pcu-ue-real-damage-') as directory:
        root = Path(directory)
        for data, reason in [(altered, 'ue-pak-index-hash-mismatch'), (outside, 'ue-range-outside-file')]:
            fact = inspect(root, {'renamed 한글/Game.pak': data})[0]
            assert fact['status'] == 'reject' and reason in fact['reasons'], fact
        toc = next(actual.rglob('TanksUnreal_v2-Linux.utoc')).read_bytes()
        fact = inspect(root, {'renamed 한글/Game.utoc': toc})[0]
        assert fact['status'] == 'reject' and 'ue-missing-ucas-partition' in fact['reasons'], fact
    print('Real TanksUnreal: mutated index hash, range and missing UCAS rejected')
