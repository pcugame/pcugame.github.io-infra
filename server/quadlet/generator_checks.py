"""Offline native-generator checks; never execute generated Podman commands."""
import os
from pathlib import Path
import shlex
import shutil
import subprocess

POD = 'graduationproject-pod.service'
POSTGRES = 'gp-postgres.service'
API = 'gp-api.service'
WORKERS = tuple('gp-worker-' + name + '.service' for name in (
    'export', 'game-validation', 'image', 'project-publication', 'video', 'webgl'))
APPLICATION = (API, *WORKERS)
WORKLOADS = (POSTGRES, *APPLICATION)


def select_generator():
    explicit = os.environ.get('QUADLET_GENERATOR')
    candidates = [explicit] if explicit else [shutil.which('quadlet'),
        '/usr/libexec/podman/quadlet', '/usr/lib/podman/quadlet',
        '/usr/lib/systemd/system-generators/podman-system-generator',
        '/run/current-system/sw/libexec/podman/quadlet']
    generator = next((path for path in candidates if path and Path(path).is_file()
                      and os.access(path, os.X_OK)), None)
    expected = os.environ.get('QUADLET_EXPECT_VERSION')
    if (explicit or expected) and not generator:
        raise AssertionError('explicit Quadlet generator verification requires an executable generator')
    if generator and expected:
        result = subprocess.run([generator, '--version'], env={'PATH': '/usr/bin:/bin'},
                                capture_output=True, text=True, timeout=30)
        if result.returncode or result.stdout.strip() != expected:
            raise AssertionError('Quadlet generator version differs from QUADLET_EXPECT_VERSION')
    return generator


def generate(generator, rendered, generated, environment):
    return subprocess.run([generator, '--user', '--no-kmsg-log', str(generated)],
                          env=environment | {'QUADLET_UNIT_DIRS': str(rendered)},
                          capture_output=True, text=True, timeout=30)


def settings(path):
    result, section = {}, ''
    for line in path.read_text().splitlines():
        if line.startswith('[') and line.endswith(']'):
            section = line[1:-1]
        elif '=' in line and not line.startswith(('#', ';')):
            key, value = line.split('=', 1)
            result.setdefault((section, key), []).append(value)
    return result


def words(unit, section, key):
    return [word for value in unit.get((section, key), []) for word in shlex.split(value)]


def assert_graph(test, generated):
    graph = {path.name: settings(path) for path in generated.glob('*.service')}
    test.assertEqual(set(graph), {POD, *WORKLOADS, 'gp-pg-data-volume.service'})
    links = sorted(str(path.relative_to(generated)) for path in generated.rglob('*') if path.is_symlink())
    test.assertEqual(links, ['default.target.wants/' + POD])
    test.assertEqual(set(words(graph[POD], 'Unit', 'Wants')) & set(graph), set(WORKLOADS))
    # Wants permits an initial start while application children are masked.
    for key in ('Requires', 'BindsTo', 'PartOf'):
        test.assertFalse(set(words(graph[POD], 'Unit', key)) & set(graph), key)
    create = words(graph[POD], 'Service', 'ExecStartPre')
    test.assertEqual(create[1:3], ['pod', 'create'])
    policies = [value.split('=', 1)[1] for value in create if value.startswith('--exit-policy=')]
    test.assertTrue(policies, 'explicit pod exit policy missing')
    test.assertEqual(policies[-1], 'continue', 'last scalar CLI flag must preserve continue semantics')
    if os.environ.get('QUADLET_EXPECT_VERSION') == '5.4.2':
        test.assertEqual(policies, ['stop', 'continue'])
    # 5.4.2's generated default stop must precede our override, which is last.
    test.assertEqual(create[-1], '--exit-policy=continue')
    test.assertIn('postgres:127.0.0.1', create)
    test.assertEqual(create[create.index('postgres:127.0.0.1') - 1], '--add-host')
    test.assertEqual(graph[POD][('Service', 'Restart')], ['on-failure'])
    for unit in WORKLOADS:
        test.assertEqual(graph[unit][('Service', 'Restart')], ['always'], unit)
        test.assertEqual(words(graph[unit], 'Unit', 'BindsTo'), [POD], unit)
        for key in ('Wants', 'Requires', 'PartOf'):
            test.assertFalse(set(words(graph[unit], 'Unit', key)) & set(WORKLOADS), unit)
        start = words(graph[unit], 'Service', 'ExecStart')
        test.assertEqual(start[1], 'run', unit)
        test.assertEqual(start[start.index('--pod-id-file') + 1], '%t/graduationproject-pod.pod-id', unit)
        test.assertIn('--env-file', start, unit)
    test.assertIn(POSTGRES, words(graph[API], 'Unit', 'After'))
    for unit in WORKERS:
        test.assertIn(API, words(graph[unit], 'Unit', 'After'), unit)
    test.assertIn('gp-pg-data-volume.service', words(graph[POSTGRES], 'Unit', 'Requires'))
    test.assertIn('gp_pg_data:/var/lib/postgresql/data:Z', words(graph[POSTGRES], 'Service', 'ExecStart'))
    volume = words(graph['gp-pg-data-volume.service'], 'Service', 'ExecStart')
    test.assertEqual(volume[-1], 'gp_pg_data')
