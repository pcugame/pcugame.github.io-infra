import importlib.util
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
        self.instance = 1
        self.upstream = 'a'

    def event(self, name):
        self.events.append(name)
        if self.fail == name:
            raise RuntimeError(name)

    def active_slot(self): return self.active
    def reconcile(self, state): self.event('reconcile')
    def preflight(self, state): self.event('preflight')
    def snapshot(self, sha): self.event('snapshot')
    def capture_candidate(self, state): self.event('capture')
    def assert_unadmitted(self, state):
        if self.upstream != state['old']: raise ValueError('ambiguous')
    def cleanup_candidate(self, state): self.event('cleanup')
    def verify_stopped(self, name): self.event('verify-stopped')
    def prepare_admission(self, state): self.event('prepare-admission')
    def candidate_identity(self, state): return self.instance
    def start_candidate(self, state):
        self.stopped.discard('gp-api-' + state['new'])
        self.event('candidate')
    def probe(self, kind, state): self.event('probe-' + kind)
    def nginx_workers(self): return [[42, 'starttime']]
    def nginx_workers_gone(self, workers): return not self.nginx_busy
    def switch(self, state):
        self.upstream = state['new']
        self.event('switch')
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
    def pause_maintenance(self, slot): self.event('pause-maintenance-' + slot)
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

    def test_success_orders_idle_stop_maintenance_and_worker_replacement(self):
        state = self.release().run()
        self.assertEqual(state['phase'], 'web-pending')
        self.assertEqual(state['workers'], rolling.WORKERS)
        events = self.host.events
        self.assertLess(events.index('probe-nas-protected'), events.index('stop-gp-api-a'))
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
        for failure in ['preflight', 'snapshot', 'candidate', 'probe-candidate', 'switch', 'probe-public', 'probe-nas-protected']:
            with self.subTest(failure=failure):
                self.file.unlink(missing_ok=True)
                self.host = Host()
                self.host.fail = failure
                with self.assertRaises(RuntimeError): self.release().run()
                if failure in ('candidate', 'probe-candidate', 'probe-nas-protected'):
                    self.assertEqual(self.release().state['phase'], 'preflight')
                    self.assertEqual(self.host.stopped, {'gp-api-b'})
                else:
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

    def test_next_direction_selects_a_from_active_b(self):
        self.host.active = 'b'
        self.host.upstream = 'b'
        state = self.release().run()
        self.assertEqual((state['old'], state['new'], self.host.active), ('b', 'a', 'a'))
        self.assertIn('stop-gp-api-b', self.host.events)
        self.assertNotIn('stop-gp-api-a', self.host.events)

    def test_preflight_failure_leaves_no_journal_and_allows_other_image(self):
        for failure in ('preflight', 'snapshot', 'capture'):
            self.host.fail = failure
            with self.assertRaises(RuntimeError): self.release().run()
            self.assertFalse(self.file.exists())
            self.assertEqual(self.release('c' * 40).state['phase'], 'preflight')

    def test_abort_interruption_resumes_without_admission(self):
        self.host.fail = 'probe-candidate'
        self.host.busy = True
        with self.assertRaises(rolling.Deferred): self.release().run()
        self.assertEqual(self.release().state['phase'], 'aborting')
        with self.assertRaises(ValueError): self.release('c' * 40)
        self.host.fail = None
        self.host.busy = False
        self.assertEqual(self.release().run()['phase'], 'aborted')
        self.assertNotIn('switch', self.host.events)
        self.assertNotIn('gp-api-a', self.host.stopped)
        self.assertEqual(self.release('c' * 40).run()['phase'], 'web-pending')

    def test_process_interruption_during_candidate_keeps_durable_cleanup_target(self):
        original = self.host.start_candidate
        def interrupted(state):
            original(state)
            raise KeyboardInterrupt()
        self.host.start_candidate = interrupted
        with self.assertRaises(KeyboardInterrupt): self.release().run()
        state = self.release().state
        self.assertEqual((state['phase'], state['new'], state['image']), ('candidate', 'b', IMAGE))
        self.assertNotIn('switch', self.host.events)
        self.assertEqual(self.release().abort()['phase'], 'aborted')
        self.assertNotIn('gp-api-a', self.host.stopped)

    def test_cleanup_failure_never_records_aborted(self):
        self.host.fail = 'cleanup'
        release = self.release()
        release.persist(phase='candidate')
        with self.assertRaises(RuntimeError): release.abort()
        self.assertEqual(self.release().state['phase'], 'aborting')
        self.host.fail = None
        self.assertEqual(self.release().run()['phase'], 'aborted')

    def test_lost_switch_response_forbids_abort_and_revalidates_restart(self):
        self.host.fail = 'switch'
        with self.assertRaises(RuntimeError): self.release().run()
        with self.assertRaises(ValueError): self.release().abort()
        self.host.instance = 2
        self.host.fail = None
        state = self.release().run()
        self.assertEqual(state['approval']['instance'], 2)
        self.assertEqual(state['phase'], 'web-pending')

    def test_restart_during_probe_cancels_without_switch(self):
        original = self.host.probe
        def probe(kind, state):
            original(kind, state)
            if kind == 'candidate': self.host.instance += 1
        self.host.probe = probe
        with self.assertRaisesRegex(ValueError, 'restarted'): self.release().run()
        self.assertEqual(__import__('json').loads(self.file.read_text())['phase'], 'aborted')
        self.assertNotIn('switch', self.host.events)

    def test_interrupt_after_intent_before_proxy_never_cancels(self):
        original = self.host.probe
        def probe(kind, state):
            if state['phase'] == 'switch': raise KeyboardInterrupt()
            original(kind, state)
        self.host.probe = probe
        with self.assertRaises(KeyboardInterrupt): self.release().run()
        self.assertEqual(self.release().state['phase'], 'switch')
        with self.assertRaises(ValueError): self.release().abort()
        self.host.probe = original
        self.assertEqual(self.release().run()['phase'], 'web-pending')

    def test_missing_counters_fail_closed(self):
        self.assertFalse(rolling.idle(dict(kind='api', requests=0)))
        self.assertFalse(rolling.idle(dict(kind='worker', active=0)))


class BoundaryTest(unittest.TestCase):
    def test_shared_host_lock_rejects_boot_and_release_before_host_access(self):
        import fcntl, os, subprocess
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'cutover-state').mkdir()
            with (root / 'cutover-state/host-release.lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                for args in ([], ['boot'], ['abort']):
                    result = subprocess.run(['python3', str(Path(rolling.__file__)), *args],
                                            env={**os.environ, 'DEPLOY_DIR': directory}, capture_output=True, text=True)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('Resource temporarily unavailable', result.stderr)
                    self.assertFalse((root / 'cutover-state/rolling-release.json').exists())

    def test_candidate_restart_policy_is_durable_and_restorable(self):
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as directory:
            host = object.__new__(rolling.Host)
            host.quadlet = Path(directory)
            host.command = Mock(return_value='')
            file = host.quadlet / 'gp-api-b.container'
            file.write_text('[Container]\nImage=' + IMAGE + '\n[Service]\nRestart=always\n')
            host.definition('gp-api-b', IMAGE, restart='no')
            self.assertIn('Restart=no', file.read_text())
            host.command.assert_called_with(['systemctl', '--user', 'daemon-reload'])
            host.definition('gp-api-b', IMAGE, restart='always')
            self.assertIn('Restart=always', file.read_text())

    def test_legacy_preflight_requires_actual_state_and_fixture_cleanup(self):
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'state.json'
            state = dict(phase='preflight', old='a', new='b')
            host = Mock()
            host.quadlet = Path(directory)
            for name in ['gp-api-a', *rolling.WORKERS]:
                (host.quadlet / (name + '.container')).write_text('Image=' + IMAGE + '\n')
            host.active_slot.return_value = 'a'
            host.proxy.return_value = {'slot': 'a'}
            host.running.return_value = False
            host.inspect.return_value = {'ImageName': IMAGE}
            rolling.save(file, state)
            host.probe.side_effect = RuntimeError('fixture cleanup unavailable')
            with self.assertRaises(RuntimeError): rolling.Host.recover_preflight(host, state, file)
            self.assertEqual(__import__('json').loads(file.read_text())['phase'], 'preflight')
            host.probe.side_effect = None
            host.running.return_value = True
            with self.assertRaises(ValueError): rolling.Host.recover_preflight(host, state, file)
            host.running.return_value = False
            rolling.Host.recover_preflight(host, state, file)
            self.assertEqual(__import__('json').loads(file.read_text())['phase'], 'aborted')
            host.verify_image.assert_called()


class BootTest(unittest.TestCase):
    def setUp(self):
        self.old = IMAGE.replace('b' * 64, 'c' * 64)
        self.definitions = {name: self.old for name in ['gp-api-a', 'gp-api-b', *rolling.WORKERS]}
        self.state = dict(phase='switch', old='a', new='b', old_image=self.old,
                          image=IMAGE, candidate_selected=True, workers=[],
                          old_workers={name: self.old for name in rolling.WORKERS})

    def test_normal_boot_selects_recorded_slot_and_workers(self):
        plan, maintenance = rolling.boot_plan(None, 'b', 'b', self.definitions)
        self.assertEqual(set(plan), {'gp-api-b', *rolling.WORKERS})
        self.assertEqual(maintenance, 'b')

    def test_switch_crash_restores_both_exact_images_paused(self):
        for proxy in ('a', 'b'):
            plan, maintenance = rolling.boot_plan(self.state, 'a', proxy, self.definitions)
            self.assertEqual(plan['gp-api-a'], self.old)
            self.assertEqual(plan['gp-api-b'], IMAGE)
            self.assertIsNone(maintenance)

    def test_partial_worker_handoff_never_upgrades_unfinished_workers_on_boot(self):
        self.state.update(phase='workers', workers=[rolling.WORKERS[0]], replacing_worker=rolling.WORKERS[1])
        plan, maintenance = rolling.boot_plan(self.state, 'b', 'b', self.definitions)
        self.assertNotIn('gp-api-a', plan)
        self.assertEqual(plan[rolling.WORKERS[0]], IMAGE)
        self.assertEqual(plan[rolling.WORKERS[1]], self.old)
        self.assertEqual(maintenance, 'b')

    def test_unapproved_boot_keeps_old_maintenance_and_never_selects_candidate(self):
        for phase in ('candidate', 'aborting'):
            self.state['phase'] = phase
            plan, maintenance = rolling.boot_plan(self.state, 'a', 'a', self.definitions)
            self.assertEqual(maintenance, 'a')
            self.assertEqual(plan['gp-api-a'], self.old)
            self.assertEqual(plan['gp-api-b'], IMAGE)
            with self.assertRaises(ValueError): rolling.boot_plan(self.state, 'a', 'b', self.definitions)

    def test_mismatch_and_missing_identities_fail_closed(self):
        with self.assertRaises(ValueError): rolling.boot_plan(None, 'a', 'b', self.definitions)
        self.state['phase'] = 'drain'
        with self.assertRaises(ValueError): rolling.boot_plan(self.state, 'b', 'a', self.definitions)
        self.state['candidate_selected'] = False
        with self.assertRaises(ValueError): rolling.boot_plan(self.state, 'b', 'b', self.definitions)


if __name__ == '__main__': unittest.main()
