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
        state = self.release().run()
        self.assertEqual((state['old'], state['new'], self.host.active), ('b', 'a', 'a'))
        self.assertIn('stop-gp-api-b', self.host.events)
        self.assertNotIn('stop-gp-api-a', self.host.events)

    def test_missing_counters_fail_closed(self):
        self.assertFalse(rolling.idle(dict(kind='api', requests=0)))
        self.assertFalse(rolling.idle(dict(kind='worker', active=0)))


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

    def test_mismatch_and_missing_identities_fail_closed(self):
        with self.assertRaises(ValueError): rolling.boot_plan(None, 'a', 'b', self.definitions)
        self.state['phase'] = 'drain'
        with self.assertRaises(ValueError): rolling.boot_plan(self.state, 'b', 'a', self.definitions)
        self.state['candidate_selected'] = False
        with self.assertRaises(ValueError): rolling.boot_plan(self.state, 'b', 'b', self.definitions)


if __name__ == '__main__': unittest.main()
