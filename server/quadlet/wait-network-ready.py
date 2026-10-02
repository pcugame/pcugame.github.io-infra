#!/usr/bin/env python3
"""Bounded cold-boot readiness gate; probes are local and never emit values."""
import json
import subprocess
import sys
import time

DEADLINE_SECONDS = 90
POLL_SECONDS = 2
SETTLE_SECONDS = 5
STABLE_OBSERVATIONS = 3


def wait_ready(*, run=subprocess.run, monotonic=time.monotonic, sleep=time.sleep):
    """Dependency injection is for offline tests; production has no bypass knobs."""
    deadline = monotonic() + DEADLINE_SECONDS

    def probe():
        def command(arguments):
            remaining = deadline - monotonic()
            if remaining <= 0:
                return None
            try:
                result = run(arguments, capture_output=True, text=True,
                             timeout=min(5, remaining), check=False)
                return result.stdout.strip() if result.returncode == 0 else None
            except (OSError, subprocess.SubprocessError, UnicodeError):
                return None
        route = command(['ip', '-4', 'route', 'show', 'default'])
        if not route or not command(['ip', '-4', 'route', 'get', '1.1.1.1']):
            return None
        status = command(['tailscale', 'status', '--json'])
        try:
            if json.loads(status)['BackendState'] != 'Running':
                return None
        except (TypeError, ValueError, KeyError):
            return None
        return route

    previous, observations = None, 0
    while monotonic() < deadline:
        route = probe()
        if monotonic() >= deadline:
            break
        observations = observations + 1 if route and route == previous else int(bool(route))
        previous = route
        if observations >= STABLE_OBSERVATIONS:
            if monotonic() + SETTLE_SECONDS >= deadline:
                break
            sleep(SETTLE_SECONDS)
            # A late route/Tailscale transition invalidates the whole window.
            if probe() == route and monotonic() < deadline:
                return True
            previous, observations = None, 0
        remaining = deadline - monotonic()
        if remaining > 0:
            sleep(min(POLL_SECONDS, remaining))
    return False


if __name__ == '__main__':
    try:
        ready = wait_ready()
    except Exception:
        ready = False
    if not ready:
        print('Network readiness failed: local routing and Tailscale did not stabilize before deadline', file=sys.stderr)
        sys.exit(1)
