#!/usr/bin/env python3
"""Reject topology drift; only application immutable Image changes are allowed."""
from pathlib import Path
import os
import re
import shlex
import sys

try:
    expected, installed = map(Path, sys.argv[1:3])
    # Definitions alone cannot certify the executable startup prerequisite.
    pod = (expected / 'graduationproject.pod').read_text()
    guards = re.findall(r'^ExecStartPre=(.+)$', pod, flags=re.M)
    if len(guards) != 1:
        raise ValueError()
    arguments = shlex.split(guards[0])
    if len(arguments) != 1:
        raise ValueError()
    helper = Path(arguments[0].replace('%%', '%').replace('$$', '$'))
    source = Path(__file__).resolve().parent / 'wait-network-ready.py'
    if helper.is_symlink() or not helper.is_file() or not os.access(helper, os.X_OK) or helper.samefile(source) or helper.read_bytes() != source.read_bytes():
        raise ValueError()
    roots = {installed, Path('/etc/containers/systemd/users'),
             Path('/etc/containers/systemd/users') / str(os.getuid())}
    environments = [os.environ]
    if sys.argv[3:] == ['--manager-env']:
        manager = {}
        for line in sys.stdin:
            key = line.partition('=')[0]
            if key in ('XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'QUADLET_UNIT_DIRS'):
                assignment = shlex.split(line.rstrip('\n'))
                if len(assignment) != 1:
                    raise ValueError()
                manager[key] = assignment[0].partition('=')[2]
        environments.append(manager)
    for environment in environments:
        roots.add(Path(environment.get('XDG_CONFIG_HOME') or str(Path.home() / '.config')) / 'containers/systemd')
        roots.add(Path(environment.get('XDG_RUNTIME_DIR') or f'/run/user/{os.getuid()}') / 'containers/systemd')
        roots.update(Path(root) for root in environment.get('QUADLET_UNIT_DIRS', '').split(':') if root)
    # Quadlet merges shared and name-prefix drop-ins across search roots.
    # A matching base definition alone does not establish effective topology.
    if any(any(root.rglob('*.d')) for root in roots):
        raise ValueError()
    for candidate in expected.iterdir():
        current = installed / candidate.name
        if current.is_symlink() or not current.is_file():
            raise ValueError()
        actual, wanted = current.read_text(), candidate.read_text()
        if candidate.suffix == '.container' and candidate.stem != 'gp-postgres':
            pattern = r'^Image=ghcr\.io/pcugame/pcu-graduationproject-v2-api@sha256:[0-9a-f]{64}$'
            if len(re.findall(pattern, actual, flags=re.M)) != 1:
                raise ValueError()
            actual = re.sub(pattern, 'Image=RELEASE', actual, flags=re.M)
            wanted = re.sub(pattern, 'Image=RELEASE', wanted, flags=re.M)
        if actual != wanted:
            raise ValueError()
except (OSError, ValueError, UnicodeError):
    print('ERROR: host must already have matching adopted Quadlet definitions; topology drift or legacy hosts require a separate reviewed adoption', file=sys.stderr)
    sys.exit(1)
