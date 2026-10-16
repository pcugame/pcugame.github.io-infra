#!/usr/bin/python3 -I
"""Install root-owned at /usr/local/sbin/pcu-api-proxy; no caller configuration."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import syslog
import tempfile

UPSTREAM = Path('/etc/nginx/pcu/api-upstream.conf')
LOCK = Path('/run/lock/pcu-api-proxy.lock')
PID = Path('/run/nginx.pid')
NGINX = '/usr/sbin/nginx'
PATTERN = r'upstream pcu_api_active\s*\{[^}]*\}'


def command(*args):
    return subprocess.check_output(args, text=True, env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin'}).strip()


def workers():
    master = int(PID.read_text())
    result = []
    for path in Path('/proc').glob('[0-9]*/stat'):
        try:
            fields = path.read_text().rsplit(')', 1)[1].split()
            if int(fields[1]) == master and b'nginx: worker process' in (path.parent / 'cmdline').read_bytes():
                result.append([int(path.parent.name), fields[19]])
        except FileNotFoundError:
            continue
    if not result:
        raise ValueError('No observable nginx workers')
    return result


def status():
    effective = command(NGINX, '-T')
    blocks = re.findall(PATTERN, effective)
    if len(blocks) != 1:
        raise ValueError('Expected exactly one active upstream')
    match = re.fullmatch(r'upstream pcu_api_active\s*\{\s*server 127\.0\.0\.1:(4000|4001);\s*\}', blocks[0])
    if not match or re.findall(PATTERN, UPSTREAM.read_text()) != blocks:
        raise ValueError('Unexpected active upstream definition')
    return dict(slot='a' if match[1] == '4000' else 'b', workers=workers(), effective=effective,
                fingerprint=hashlib.sha256(re.sub(PATTERN, 'upstream pcu_api_active { SLOT }', effective).encode()).hexdigest())


def replace(content):
    # Unique O_EXCL file in the root-owned directory: interruption cannot leave
    # a fixed temporary name that blocks an explicit retry.
    fd, temporary = tempfile.mkstemp(prefix='.api-upstream-', suffix='.tmp', dir=UPSTREAM.parent)
    temp = Path(temporary)
    os.fchmod(fd, 0o644)
    try:
        with os.fdopen(fd, 'w') as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temp, UPSTREAM)
        fd = os.open(UPSTREAM.parent, os.O_RDONLY)
        try: os.fsync(fd)
        finally: os.close(fd)
    finally:
        temp.unlink(missing_ok=True)


def main(args):
    if args not in (['status'], ['check'], ['switch', 'a'], ['switch', 'b']):
        raise ValueError('Expected status, check, or switch a|b')
    with LOCK.open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if args == ['check']:
            command(NGINX, '-t')
        elif args[0] == 'switch':
            before = status()
            old = UPSTREAM.read_text()
            slot = args[1]
            syslog.syslog(syslog.LOG_NOTICE, f'pcu-api-proxy switch intent {before["slot"]}->{slot}')
            content = f'upstream pcu_api_active {{\n    server 127.0.0.1:{4000 if slot == "a" else 4001};\n}}\n'
            replace(content)
            try:
                command(NGINX, '-t')
            except Exception:
                replace(old)  # No reload occurred. Preserve the tested configuration.
                raise
            command(NGINX, '-s', 'reload')
            syslog.syslog(syslog.LOG_NOTICE, f'pcu-api-proxy reload requested slot={slot}; live probes required')
        print(json.dumps(status()))


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except Exception as error:
        syslog.syslog(syslog.LOG_ERR, 'pcu-api-proxy failed: ' + str(error))
        print(str(error), file=sys.stderr)
        sys.exit(1)
