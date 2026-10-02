#!/usr/bin/env python3
"""Opt-in generated-graph lifecycle check with harmless transient user services.

RUN_QUADLET_LIFECYCLE_TESTS=1 python3 server/quadlet/lifecycle.test.py
QUADLET_GENERATOR=/absolute/path/to/quadlet selects the actual generator.
This checks systemd policy, not container/Podman runtime behavior. It never loads
production units or executes generated ExecStart/ExecStop commands. Existing user
manager use is limited to uniquely named, non-enabled transient fixture units;
no daemon reload, manager restart, reboot, or production runtime access occurs.
"""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
sys.dont_write_bytecode = True
from generator_checks import select_generator, assert_graph

HERE = Path(__file__).resolve().parent
POD = 'graduationproject-pod.service'
POSTGRES = 'gp-postgres.service'
API = 'gp-api.service'
WORKERS = tuple('gp-worker-' + name + '.service' for name in (
    'export', 'game-validation', 'image', 'project-publication', 'video', 'webgl'))
APPLICATION = (API, *WORKERS)
WORKLOADS = (POSTGRES, *APPLICATION)
LONG_RUNNING = (POD, *WORKLOADS)
RELATIONSHIPS = ('Wants', 'Requires', 'BindsTo', 'PartOf', 'After', 'Before')


def settings(path):
    """Read duplicate systemd keys without flattening their section boundaries."""
    result, section = {}, ''
    for line in path.read_text().splitlines():
        if line.startswith('[') and line.endswith(']'):
            section = line[1:-1]
        elif '=' in line and not line.startswith(('#', ';')):
            key, value = line.split('=', 1)
            result.setdefault((section, key), []).append(value)
    return result


def words(unit, section, key):
    return [word for value in unit.get((section, key), []) for word in value.split()]


@unittest.skipUnless(os.environ.get('RUN_QUADLET_LIFECYCLE_TESTS') == '1',
                     'opt in with RUN_QUADLET_LIFECYCLE_TESTS=1; requires user systemd and Quadlet')
class Lifecycle(unittest.TestCase):
    def command(self, arguments, *, env=None, check=True):
        result = subprocess.run(arguments, env=env or self.environment,
                                capture_output=True, text=True, timeout=30)
        if check and result.returncode:
            self.fail(f'{Path(arguments[0]).name} failed (exit {result.returncode}); output withheld')
        return result

    def control(self, verb, units, *options, check=True):
        # Restrict every systemctl mutation and query to this invocation's fixtures.
        mapped = [self.names[unit] for unit in units]
        self.assertTrue(all(name.startswith(self.prefix) for name in mapped))
        return self.command([self.systemctl, '--user', verb, *options, *mapped], check=check)

    def state(self, unit):
        result = self.control('show', [unit], '--property=ActiveState', '--property=MainPID',
                              '--property=NRestarts', '--property=LoadState')
        return dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)

    def wait_for(self, predicate, description):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.05)
        self.fail('timed out: ' + description)

    def invocation_count(self, unit):
        path = self.counts[unit]
        return len(path.read_text().splitlines()) if path.exists() else 0

    def assert_stays_stopped(self, units):
        before = {unit: self.invocation_count(unit) for unit in units}
        time.sleep(0.7)  # More than three fixture RestartSec intervals.
        for unit in units:
            self.assertEqual(self.state(unit)['ActiveState'], 'inactive', unit)
            self.assertEqual(self.invocation_count(unit), before[unit], unit)

    def test_generated_graph_and_surrogate_lifecycle(self):
        # Only explicitly needed session variables cross the subprocess boundary.
        # Never copy the deployment environment or open operator env files.
        tool_dirs = {str(Path(sys.executable).parent)}
        for tool in ('bash', 'env', 'dirname', 'python3', 'systemctl', 'systemd-run', 'systemd-analyze'):
            resolved = shutil.which(tool)
            if resolved:
                tool_dirs.add(str(Path(resolved).parent))
        self.environment = {'PATH': ':'.join(sorted(tool_dirs)),
                            'PYTHONDONTWRITEBYTECODE': '1'}
        for key in ('XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'):
            if key in os.environ:
                self.environment[key] = os.environ[key]
        self.systemctl = shutil.which('systemctl')
        systemd_run = shutil.which('systemd-run')
        generator = select_generator()
        analyze = shutil.which('systemd-analyze')
        self.assertTrue(self.systemctl and systemd_run and generator and analyze,
                        'systemctl, systemd-run, systemd-analyze and QUADLET_GENERATOR are required')
        generator = str(Path(generator).resolve())
        self.assertTrue(Path(generator).is_file(), 'Quadlet generator must be an executable file')
        self.prefix = 'quadlet-lifecycle-' + uuid.uuid4().hex + '-'
        self.names, self.counts, created = {}, {}, []
        with tempfile.TemporaryDirectory(prefix='quadlet-lifecycle-') as temporary:
            root = Path(temporary)
            # HOME is private. No production config/secrets are loaded by tools.
            self.environment['HOME'] = str(root)
            render_environment = dict(self.environment, API_IMAGE=
                'ghcr.io/pcugame/pcu-graduationproject-v2-api@sha256:' + 'a' * 64,
                DEPLOY_DIR=str(root / 'deployment'))
            rendered, generated = root / 'quadlet', root / 'generated'
            self.command([shutil.which('bash'), str(HERE / 'render.sh'), str(rendered)],
                         env=render_environment)
            # Verify service syntax without requiring Podman on this test machine.
            # Only the command's executable path is substituted; no generated
            # command is executed, and all flags/dependencies remain native.
            generator_environment = dict(self.environment, QUADLET_UNIT_DIRS=str(rendered),
                                         PODMAN=shutil.which('true'))
            self.command([generator, '--user', '--no-kmsg-log', str(generated)], env=generator_environment)
            assert_graph(self, generated)
            graph = {path.name: settings(path) for path in generated.glob('*.service')}
            self.command([analyze, '--user', 'verify',
                          *[str(generated / name) for name in sorted(graph)]],
                         env=dict(self.environment, SYSTEMD_UNIT_PATH=str(generated) + ':'))
            self.assertEqual(set(graph), {*LONG_RUNNING, 'gp-pg-data-volume.service'})
            links = sorted(str(path.relative_to(generated)) for path in generated.rglob('*')
                           if path.is_symlink())
            self.assertEqual(links, ['default.target.wants/' + POD])
            self.assertEqual(set(words(graph[POD], 'Unit', 'Wants')) & set(graph),
                             {POSTGRES, *APPLICATION})
            self.assertEqual(settings(rendered / 'graduationproject.pod').get(('Pod', 'PodmanArgs')),
                             ['--exit-policy=continue'])
            self.assertEqual(graph[POD].get(('Service', 'Restart')), ['on-failure'])
            for unit in WORKLOADS:
                self.assertEqual(graph[unit].get(('Service', 'Restart')), ['always'], unit)
            for unit in (POSTGRES, *APPLICATION):
                self.assertEqual(words(graph[unit], 'Unit', 'BindsTo'), [POD], unit)
                peer_wants = set(words(graph[unit], 'Unit', 'Wants')) & set(graph)
                self.assertFalse(peer_wants, unit)
            self.assertIn(POSTGRES, words(graph[API], 'Unit', 'After'))
            for unit in WORKERS:
                self.assertIn(API, words(graph[unit], 'Unit', 'After'))
            self.names = {unit: self.prefix + unit for unit in graph}
            self.counts = {unit: root / (unit + '.invocations') for unit in graph}
            dummy = root / 'dummy.py'
            dummy.write_text('''import os, signal, sys, time
signal.signal(signal.SIGUSR1, lambda *_: sys.exit(1))
signal.signal(signal.SIGUSR2, lambda *_: sys.exit(0))
with open(sys.argv[1], 'a') as count:
    count.write(str(os.getpid()) + '\\n')
while True:
    time.sleep(1)
''')
            try:
                # Create the volume surrogate first; pod Wants references retain
                # inactive transient children so an explicit start can reuse them.
                for unit in ('gp-pg-data-volume.service', *LONG_RUNNING):
                    properties = ['Type=simple', 'RestartSec=200ms', 'StartLimitIntervalSec=0',
                                  'StandardOutput=null', 'StandardError=null']
                    restart = graph[unit].get(('Service', 'Restart'))
                    if restart:
                        properties.append('Restart=' + restart[-1])
                    for relationship in RELATIONSHIPS:
                        peers = [self.names[peer] for peer in words(graph[unit], 'Unit', relationship)
                                 if peer in graph]
                        if peers:
                            properties.append(relationship + '=' + ' '.join(peers))
                    arguments = [systemd_run, '--user', '--quiet', '--unit=' + self.names[unit]]
                    arguments += ['--property=' + prop for prop in properties]
                    arguments += [shutil.which('env'), '-i', 'HOME=' + str(root),
                                  'PYTHONDONTWRITEBYTECODE=1', sys.executable,
                                  str(dummy), str(self.counts[unit])]
                    # Register cleanup before creation: a timeout may still create a unit.
                    created.append(unit)
                    self.command(arguments)
                    if unit == POD:
                        # Wants failures from unavailable children must not
                        # prevent initial pod startup. Real adoption masks app
                        # children until PG readiness and API health are checked.
                        self.wait_for(lambda: self.state(POD)['ActiveState'] == 'active',
                                      'pod active with unavailable workload Wants')
                self.wait_for(lambda: all(self.state(unit)['ActiveState'] == 'active'
                                           and self.invocation_count(unit) >= 1
                                           for unit in LONG_RUNNING), 'all fixture services active')
                for unit in WORKLOADS:
                    for signal in ('SIGUSR1', 'SIGUSR2'):
                        before = self.invocation_count(unit)
                        self.control('kill', [unit], '--kill-whom=main', '--signal=' + signal)
                        self.wait_for(lambda: self.invocation_count(unit) > before
                                      and self.state(unit)['ActiveState'] == 'active',
                                      unit + ' automatic restart after ' + signal)
                    self.assertGreaterEqual(int(self.state(unit)['NRestarts']), 2, unit)
                postgres_pid = self.state(POSTGRES)['MainPID']
                postgres_count = self.invocation_count(POSTGRES)
                self.control('stop', APPLICATION)
                self.assert_stays_stopped(APPLICATION)
                self.assertEqual(self.state(POSTGRES)['ActiveState'], 'active')
                self.assertEqual(self.state(POSTGRES)['MainPID'], postgres_pid)
                self.assertEqual(self.invocation_count(POSTGRES), postgres_count)
                for unit in APPLICATION:
                    before = self.invocation_count(unit)
                    self.control('start', [unit])
                    self.wait_for(lambda: self.invocation_count(unit) > before
                                  and self.state(unit)['ActiveState'] == 'active', unit + ' explicit start')
                    self.control('stop', [unit])
                self.assert_stays_stopped(APPLICATION)
                # Probe a PG restart during drain. Report actual transaction behavior;
                # pod-wide Wants can re-enqueue application units via BindsTo.
                self.control('restart', [POSTGRES])
                time.sleep(0.7)
                pulled = [unit for unit in APPLICATION if self.state(unit)['ActiveState'] == 'active']
                self.assertEqual(pulled, [], 'PG restart must preserve application drain')
                print('PG restart during application drain starts: none')
                self.control('stop', [POSTGRES])
                self.assert_stays_stopped((POSTGRES, *APPLICATION))
                before = self.invocation_count(POSTGRES)
                self.control('start', [POSTGRES])
                self.wait_for(lambda: self.invocation_count(POSTGRES) > before
                              and self.state(POSTGRES)['ActiveState'] == 'active',
                              'PostgreSQL explicit start after stop')
                self.assert_stays_stopped(APPLICATION)
                print('Generator: ' + self.command([generator, '--version']).stdout.strip())
                print('Systemd: ' + self.command([self.systemctl, '--version']).stdout.splitlines()[0])
                print('Verified generated graph and systemd surrogate policy; no Podman runtime exercised.')
            finally:
                if created:
                    # Stopping all fixtures in one transaction prevents restart/dependency churn.
                    self.control('stop', created, check=False)
                    self.control('reset-failed', created, check=False)
                    for unit in created:
                        self.assertIn(self.state(unit).get('ActiveState'), ('inactive', 'failed'),
                                      'fixture cleanup: ' + unit)


if __name__ == '__main__':
    unittest.main()
