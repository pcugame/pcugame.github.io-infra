#!/usr/bin/env python3
"""Build-time dependency fetch; runtime never downloads parsers or codecs."""
import hashlib
from pathlib import Path
import tarfile
import urllib.request

root = Path(__file__).resolve().parent
revision = '605672df7a993a90094bad92d30c388d87ae6c1a'
expected = 'b65be1395e2dd135c1e53c4aafad1bdb38ed18f98fb89cd52f3215d1bc27ec2a'
archive = root / '.source.tar.gz'
body = urllib.request.urlopen(f'https://codeload.github.com/FabianFG/CUE4Parse/tar.gz/{revision}', timeout=120).read()
if hashlib.sha256(body).hexdigest() != expected:
    raise RuntimeError('CUE4Parse source digest mismatch')
archive.write_bytes(body)
with tarfile.open(archive) as source:
    for member in source.getmembers():
        member.name = '/'.join(member.name.split('/')[1:])
        if member.name:
            source.extract(member, root / '.vendor', filter='data')
# Security override for upstream's transitive Microsoft.Bcl.Memory 9.0.0
# (GHSA-73j8-2gch-69rq). Parser source and behavior remain at the pinned revision.
project = root / '.vendor/CUE4Parse/CUE4Parse.csproj'
project.write_text(project.read_text(encoding='utf-8-sig').replace('<PackageReference Include="Berrysoft.XXTea" />', '<PackageReference Include="Microsoft.Bcl.Memory" />\n    <PackageReference Include="Berrysoft.XXTea" />'))
versions = root / '.vendor/Directory.Packages.props'
versions.write_text(versions.read_text().replace('<ItemGroup>', '<ItemGroup>\n    <PackageVersion Include="Microsoft.Bcl.Memory" Version="10.0.10" />', 1))
build_props = root / '.vendor/Directory.Build.props'
build_props.write_text(build_props.read_text().replace('<TargetFramework>net10.0</TargetFramework>', '<TargetFramework>net10.0</TargetFramework>\n    <RuntimeIdentifiers>linux-x64;linux-arm64</RuntimeIdentifiers>'))
# Preserve the reviewed NuGet graph across a fresh source fetch.
lock = root / 'CUE4Parse.packages.lock.json'
if lock.exists():
    (root / '.vendor/CUE4Parse/packages.lock.json').write_bytes(lock.read_bytes())
archive.unlink()
