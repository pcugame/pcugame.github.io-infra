import importlib.util
import json
import os
import shutil
import subprocess
import sys
import time
from unittest.mock import patch
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('rolling', Path(__file__).with_name('rolling-release.py'))
rolling = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rolling)
SHA = 'a' * 40
IMAGE = 'ghcr.io/pcugame/pcu-graduationproject-v2-api@sha256:' + 'b' * 64


class Host:
    def __init__(self):
        self.events = []
        self.active = 'a'
        self.busy = False
        self.nginx_busy = False
        self.fail = None
        self.stopped = set()

    def event(self, name):
        self.events.append(name)
        if self.fail == name:
            raise RuntimeError(name)

    def active_slot(self): return self.active
    def reconcile(self, state): self.event('reconcile')
    def preflight(self, state): self.event('preflight')
    def snapshot(self, sha): self.event('snapshot')
    def start_candidate(self, state): self.event('candidate')
    def probe(self, kind, state): self.event('probe-' + kind)
    def nginx_workers(self): return [[42, 'starttime']]
    def nginx_workers_gone(self, workers): return not self.nginx_busy
    def switch(self, state): self.event('switch')
    def set_active(self, slot): self.active = slot
    def running(self, name): return name not in self.stopped
    def stop(self, name):
        self.event('stop-' + name)
        self.stopped.add(name)
    def control(self, name, command, scope='all'):
        self.event(f'{command}-{name}-{scope}')
        if name.startswith('gp-worker-'):
            return dict(kind='worker', paused=True, active=int(self.busy))
        return dict(kind='api', accepting=False, requests=0, handlers=int(self.busy),
                    maintenance=dict(paused=True, active=0, error=False))
    def enable_maintenance(self, state): self.event('maintenance')
    def maintenance_ready(self, state): return True
    def replace_worker(self, name, state):
        self.event('replace-' + name)
        self.stopped.discard(name)
    def verify_image(self, *args): self.event('verify-image')
    def verify_runtime(self, state): self.event('verify-runtime')


class ReleaseTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.file = Path(self.temp.name) / 'state.json'
        self.host = Host()

    def release(self, sha=SHA):
        return rolling.Release(self.host, self.file, sha, IMAGE, observe=0)

    def test_read_only_failures_do_not_create_a_pending_journal(self):
        for failure in ['reconcile', 'preflight', 'snapshot']:
            with self.subTest(failure=failure):
                self.host.fail = failure
                with self.assertRaises(RuntimeError): self.release().run()
                self.assertFalse(self.file.exists())
                self.release('c' * 40)  # Another release can perform its own checks.
                self.assertFalse(self.host.stopped)

    def test_legacy_preflight_can_be_replaced_without_marking_it_complete(self):
        state = dict(sha=SHA, image=IMAGE, old='a', new='b', phase='preflight', workers=[])
        rolling.save(self.file, state)
        before = self.file.read_bytes()
        self.host.fail = 'preflight'
        with self.assertRaises(RuntimeError): self.release('c' * 40).run()
        self.assertEqual(self.file.read_bytes(), before)
        self.host.fail = None
        self.assertEqual(self.release('c' * 40).run()['phase'], 'web-pending')

    def test_candidate_is_durable_before_any_service_change(self):
        def candidate(state):
            self.assertEqual(json.loads(self.file.read_text()), state)
            self.assertEqual(state['phase'], 'candidate')
            raise RuntimeError('candidate started')
        self.host.start_candidate = candidate
        with self.assertRaisesRegex(RuntimeError, 'candidate started'): self.release().run()
        with self.assertRaisesRegex(ValueError, 'unfinished'): self.release('c' * 40)

    def test_failed_durable_save_cannot_start_candidate(self):
        with patch.object(rolling, 'save', side_effect=OSError('disk failure')):
            with self.assertRaises(OSError): self.release().run()
        self.assertNotIn('candidate', self.host.events)

    def test_real_schema_preflight_rejection_leaves_no_pending_journal(self):
        host = rolling.Host.__new__(rolling.Host)
        host.root = Path(self.temp.name)
        host.config = {'version': 1}
        host.inspect = lambda name: {'ImageName': IMAGE}
        host.verify_image = lambda *args: None
        host.running = lambda name: False
        host.control = lambda *args: dict(kind='worker', paused=False, maintenance={'paused': False})
        commands = []
        def command(args):
            commands.append(args)
            if args[-1] == 'rolling-schema-check':
                raise subprocess.CalledProcessError(1, args, stderr='Unapplied migration')
            return ''
        host.command = command
        self.host.preflight = host.preflight
        with self.assertRaises(subprocess.CalledProcessError): self.release().run()
        self.assertEqual([args[2:] for args in commands], [
            ['release-artifact-preflight', 'phase2'], ['rolling-schema-check']])
        self.assertFalse(self.file.exists())
        self.assertNotIn('candidate', self.host.events)
        self.release('c' * 40)

    def test_fsync_failure_cannot_start_candidate_or_lose_persisted_fence(self):
        fsync = rolling.os.fsync
        for failing_call in [1, 2]:
            with self.subTest(failing_call=failing_call):
                self.file.unlink(missing_ok=True)
                calls = 0
                def checked_fsync(fd):
                    nonlocal calls
                    calls += 1
                    if calls == failing_call: raise OSError('fsync failed')
                    fsync(fd)
                with patch.object(rolling.os, 'fsync', side_effect=checked_fsync):
                    with self.assertRaises(OSError): self.release().run()
                self.assertNotIn('candidate', self.host.events)
                if failing_call == 2:  # Rename occurred; conservatively retain the journal.
                    self.assertEqual(json.loads(self.file.read_text())['phase'], 'candidate')
                    with self.assertRaisesRegex(ValueError, 'unfinished'): self.release('c' * 40)
                else:
                    self.assertFalse(self.file.exists())

    def test_legacy_preflight_rechecks_current_slot_and_preserves_previous_completion(self):
        rolling.save(self.file, dict(sha=SHA, image=IMAGE, old='a', new='b', phase='preflight'))
        self.host.active = 'b'
        release = self.release()
        self.assertEqual((release.state['old'], release.state['new']), ('b', 'a'))
        rolling.save(self.file, dict(sha='c' * 40, image=IMAGE, phase='complete'))
        before = self.file.read_bytes()
        self.host.fail = 'preflight'
        with self.assertRaises(RuntimeError): self.release().run()
        self.assertEqual(self.file.read_bytes(), before)

    def test_success_orders_idle_stop_maintenance_and_worker_replacement(self):
        state = self.release().run()
        self.assertEqual(state['phase'], 'web-pending')
        self.assertEqual(state['workers'], rolling.WORKERS)
        events = self.host.events
        self.assertLess(events.index('probe-internal'), events.index('stop-gp-api-a'))
        self.assertLess(events.index('stop-gp-api-a'), events.index('maintenance'))
        for worker in rolling.WORKERS:
            self.assertLess(events.index('status-' + worker + '-all'), events.index('stop-' + worker))

    def test_live_nginx_generation_prevents_http_quiesce_and_stop(self):
        self.host.nginx_busy = True
        with self.assertRaises(rolling.Deferred): self.release().run()
        self.assertNotIn('quiesce-gp-api-a-all', self.host.events)
        self.assertFalse(self.host.stopped)
        self.assertEqual(self.host.active, 'b')

    def test_detached_handler_prevents_stop_and_another_release(self):
        self.host.busy = True
        with self.assertRaises(rolling.Deferred): self.release().run()
        self.assertFalse(self.host.stopped)
        with self.assertRaisesRegex(ValueError, 'unfinished'): self.release('c' * 40)
        self.host.busy = False
        self.assertEqual(self.release().run()['phase'], 'web-pending')

    def test_preflight_candidate_and_reload_failures_preserve_processes(self):
        for failure in ['preflight', 'snapshot', 'candidate', 'probe-candidate', 'switch', 'probe-public', 'probe-internal']:
            with self.subTest(failure=failure):
                self.file.unlink(missing_ok=True)
                self.host = Host()
                self.host.fail = failure
                with self.assertRaises(RuntimeError): self.release().run()
                self.assertFalse(self.host.stopped)
                self.host.fail = None
                self.assertEqual(self.release().run()['phase'], 'web-pending')

    def test_worker_failure_resumes_same_release_without_repeating_completed_workers(self):
        worker = rolling.WORKERS[1]
        self.host.fail = 'replace-' + worker
        with self.assertRaises(RuntimeError): self.release().run()
        self.assertEqual(self.host.active, 'b')
        self.host.fail = None
        self.release().run()
        self.assertEqual(self.host.events.count('replace-' + rolling.WORKERS[0]), 1)

    def test_missing_counters_fail_closed(self):
        self.assertFalse(rolling.idle(dict(kind='api', requests=0)))
        self.assertFalse(rolling.idle(dict(kind='worker', active=0)))



class JournalEntryPointTest(unittest.TestCase):
    """Run the real lock/journal entry points with service operations confined to fixtures."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.server = Path(__file__).resolve().parent
        (self.root / 'cutover-state').mkdir()
        self.file = self.root / 'cutover-state/rolling-release.json'
        self.env = {**os.environ, 'DEPLOY_DIR': str(self.root), 'RELEASE_SOURCE_SHA': SHA,
                    'FINAL_IMAGE': IMAGE, 'RELEASE_RUN_KEY': 'fixture-1'}
        for name in ['RELEASE_HOST_LOCK_HELD', 'RELEASE_ROLLING_ACTIVE', 'CUTOVER_STATE_DIR']:
            self.env.pop(name, None)
        # Keep both production shell guards and dispatch, substitute only host operations.
        shutil.copy(self.server / 'deploy.sh', self.root / 'deploy.sh')
        modules = self.root / 'deploy'
        modules.mkdir()
        for name in ['common', 'lifecycle', 'preflight', 'backup', 'migrate', 'activate', 'smoke']:
            (modules / (name + '.sh')).write_text('')
        (modules / 'common.sh').write_text('CUTOVER_STATE_DIR="$DEPLOY_DIR/cutover-state"\n')
        (modules / 'activate.sh').write_text('do_activation_preflight() { :; }; do_activate() { echo maintenance-entered; }\n')
        (modules / 'migrate.sh').write_text('do_release_migration() { echo migration-status-entered; }\n')
        (self.root / 'ip-ban-audit.sh').write_text('echo audit-entered\n')
        (self.root / 'release-recovery.mjs').write_text("console.log('recovery-entered');\n")
        self.runner = self.root / 'runner.py'
        self.runner.write_text(fr"""
import importlib.util, json, os, time
from pathlib import Path
spec = importlib.util.spec_from_file_location('fixture', {str(Path(__file__).resolve())!r})
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
rolling = fixture.rolling
class Host(fixture.Host):
    def __init__(self, root):
        super().__init__()
        self.root = Path(root)
    def event(self, name):
        with (self.root / 'events').open('a') as out: out.write(name + '\n')
        if name == os.environ.get('HOLD_STAGE'):
            (self.root / 'held').write_text(name)
            time.sleep(60)
        if name == os.environ.get('FAIL_STAGE'): raise RuntimeError(name)
    def start_candidate(self, state):
        assert json.loads((self.root / 'cutover-state/rolling-release.json').read_text())['phase'] == 'candidate'
        started = self.root / 'candidate-started'
        if not started.exists():
            started.write_text('started')
            self.event('service-start')
        self.event('candidate')
rolling.Host = Host
rolling.main()
""")

    def command(self, kind):
        if kind == 'rolling': return [sys.executable, str(self.runner)]
        if kind == 'maintenance': return ['bash', str(self.root / 'deploy.sh'), 'up']
        return ['bash', str(self.server / 'release-orchestrate.sh'), 'activate' if kind == 'maintenance-orchestrated' else kind]

    def run_command(self, kind, **env):
        return subprocess.run(self.command(kind), env={**self.env, **env}, capture_output=True, text=True, timeout=10)

    def assert_entry(self, allowed):
        for kind in ['maintenance', 'maintenance-orchestrated', 'recover', 'assert-pre-migration']:
            result = self.run_command(kind)
            self.assertEqual(result.returncode == 0, allowed, (kind, result.stderr))
            self.assertEqual('entered' in result.stdout, allowed, (kind, result.stdout))

    def test_read_only_failure_and_legacy_journal_allow_maintenance_recovery_and_other_release(self):
        for legacy in [False, True]:
            with self.subTest(legacy=legacy):
                self.file.unlink(missing_ok=True)
                if legacy:
                    rolling.save(self.file, dict(sha=SHA, image=IMAGE, old='a', new='b', phase='preflight'))
                result = self.run_command('rolling', FAIL_STAGE='preflight')
                self.assertNotEqual(result.returncode, 0)
                self.assert_entry(True)
                other = self.run_command('rolling', RELEASE_SOURCE_SHA='c' * 40, FAIL_STAGE='preflight')
                self.assertIn('RuntimeError: preflight', other.stderr)
                self.assertNotIn('unfinished', other.stderr)

    def test_state_changing_failures_keep_all_fences_and_same_release_resume(self):
        for stage in ['candidate', 'probe-public']:
            with self.subTest(stage=stage):
                self.file.unlink(missing_ok=True)
                result = self.run_command('rolling', FAIL_STAGE=stage)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(json.loads(self.file.read_text())['phase'], 'candidate' if stage == 'candidate' else 'switch')
                self.assert_entry(False)
                self.assertIn('unfinished', self.run_command('rolling', RELEASE_SOURCE_SHA='c' * 40).stderr)
                resumed = self.run_command('rolling')
                self.assertEqual(resumed.returncode, 0, resumed.stderr)
                self.assertEqual(json.loads(self.file.read_text())['phase'], 'web-pending')

    def test_process_death_and_lock_contention_before_and_after_candidate(self):
        for stage in ['preflight', 'candidate']:
            with self.subTest(stage=stage):
                self.file.unlink(missing_ok=True)
                (self.root / 'held').unlink(missing_ok=True)
                child = subprocess.Popen(self.command('rolling'), env={**self.env, 'HOLD_STAGE': stage},
                                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                try:
                    deadline = time.monotonic() + 5
                    while not (self.root / 'held').exists():
                        self.assertIsNone(child.poll())
                        self.assertLess(time.monotonic(), deadline)
                        time.sleep(0.01)
                    self.assertEqual(self.file.exists(), stage == 'candidate')
                    contender = self.run_command('rolling')
                    self.assertNotEqual(contender.returncode, 0)
                    self.assertIn('BlockingIOError', contender.stderr)
                    self.assert_entry(False)  # The host lock protects even a journal-free preflight.
                finally:
                    child.kill()
                    child.wait(timeout=5)
                if stage == 'preflight':
                    self.assert_entry(True)
                    resumed = self.run_command('rolling', RELEASE_SOURCE_SHA='c' * 40, FAIL_STAGE='preflight')
                    self.assertIn('RuntimeError: preflight', resumed.stderr)
                else:
                    self.assert_entry(False)
                    self.assertIn('unfinished', self.run_command('rolling', RELEASE_SOURCE_SHA='c' * 40).stderr)
                    resumed = self.run_command('rolling')
                    self.assertEqual(resumed.returncode, 0, resumed.stderr)
                    self.assertEqual((self.root / 'events').read_text().splitlines().count('service-start'), 1)


if __name__ == '__main__': unittest.main()
