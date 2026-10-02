#!/usr/bin/env python3
"""Cold-boot readiness simulation with no network or wall-clock waits."""
import importlib.util
from pathlib import Path
import subprocess
import contextlib
import io
import runpy
from unittest.mock import patch
import unittest
import sys
sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('readiness', Path(__file__).with_name('wait-network-ready.py'))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class Clock:
    now = 0
    calls = None
    def __init__(self, route=lambda t: 'default via fixture', status=lambda t: '{"BackendState":"Running"}', lookup=lambda t: 'fixture'):
        self.route, self.status, self.lookup = route, status, lookup
        self.calls = []
    def run(self, args, **kwargs):
        self.calls.append((self.now, args, kwargs['timeout']))
        answer = (self.route if args[-1] == 'default' else self.lookup if args[-1] == '1.1.1.1' else self.status)(self.now)
        if isinstance(answer, Exception): raise answer
        return subprocess.CompletedProcess(args, 1 if answer is None else 0, answer or '', 'private-error')
    def sleep(self, duration): self.now += duration
    def wait(self): return gate.wait_ready(run=self.run, monotonic=lambda: self.now, sleep=self.sleep)


class Readiness(unittest.TestCase):
    def test_stable(self):
        clock = Clock()
        self.assertTrue(clock.wait())
        self.assertEqual(clock.now, 9)
        self.assertEqual([t for t,a,_ in clock.calls if a[-1] == 'default'], [0,2,4,9])
    def test_delayed_cold_boot(self):
        clock = Clock(route=lambda t: '' if t < 7 else 'default fixture', status=lambda t: '{"BackendState":"Starting"}' if t < 11 else '{"BackendState":"Running"}')
        self.assertTrue(clock.wait())
        self.assertEqual(clock.now, 21)
    def test_missing_changing_routes_and_lookup_fail_closed(self):
        for route, lookup in ((lambda t: '', lambda t: 'fixture'), (lambda t: str(t), lambda t: 'fixture'), (lambda t: 'fixture', lambda t: None)):
            clock = Clock(route=route, lookup=lookup)
            self.assertFalse(clock.wait())
            self.assertLessEqual(clock.now, 90)
    def test_settle_changes_restart_entire_window(self):
        clock = Clock(route=lambda t: 'old' if t < 8 else 'new')
        self.assertTrue(clock.wait())
        self.assertEqual(clock.now, 20)
    def test_tailscale_unavailable_bad_json_or_not_running(self):
        for status in (None, '{}', '[]', 'private-invalid-json', '{"BackendState":"Starting"}', FileNotFoundError('private-command')):
            clock = Clock(status=lambda t: status)
            self.assertFalse(clock.wait())
            self.assertLessEqual(clock.now, 90)
    def test_command_timeout_and_deadline_are_bounded(self):
        clock = Clock(route=lambda t: subprocess.TimeoutExpired('private-command', 5))
        self.assertFalse(clock.wait())
        self.assertTrue(all(0 < timeout <= 5 for _,_,timeout in clock.calls))
        self.assertLessEqual(clock.now, 90)
    def test_deadline_during_probe_cannot_succeed(self):
        clock = Clock()
        original = clock.run
        def slow(args, **kwargs):
            if args[-1] == 'default' and len([a for _,a,_ in clock.calls if a[-1] == 'default']) == 3:
                clock.now = 89
            answer = original(args, **kwargs)
            clock.now = min(90, clock.now + kwargs['timeout'])
            return answer
        clock.run = slow
        self.assertFalse(clock.wait())
        self.assertLessEqual(clock.now, 90)
    def test_cli_error_diagnostic_never_contains_values(self):
        clock, stderr = Clock(route=lambda t: FileNotFoundError('private-command')), io.StringIO()
        with patch('subprocess.run', clock.run), patch('time.monotonic', lambda: clock.now), patch('time.sleep', clock.sleep), contextlib.redirect_stderr(stderr):
            with self.assertRaises(SystemExit) as caught:
                runpy.run_path(gate.__file__, run_name='__main__')
        self.assertEqual(caught.exception.code, 1)
        self.assertNotIn('private', stderr.getvalue())
        self.assertEqual(stderr.getvalue(), 'Network readiness failed: local routing and Tailscale did not stabilize before deadline\n')



if __name__ == '__main__': unittest.main()
