#!/usr/bin/env python3
"""Offline deploy.sh structural parity with innocuous fixtures and process doubles."""
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch
sys.dont_write_bytecode = True
from generator_checks import select_generator, generate, assert_graph

HERE = Path(__file__).resolve().parent
DEPLOY = HERE.parent / 'deploy.sh'
IMAGE = 'ghcr.io/pcugame/pcu-graduationproject-v2-api@sha256:' + 'a' * 64
COMMON_REQUIRED = '''SESSION_SECRET GOOGLE_CLIENT_IDS DATABASE_URL S3_ENDPOINT
S3_PUBLIC_SIGNING_ENDPOINT S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT PUBLIC_ASSET_ORIGIN
S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY API_PUBLIC_URL WEB_PUBLIC_URL CORS_ALLOWED_ORIGINS
DIRECT_UPLOAD_PART_URL_REFRESH_MAX UPLOAD_USER_GAME_MAX_MB UPLOAD_PRIVILEGED_GAME_MAX_MB
DIRECT_UPLOAD_WORKER_TEMP_MAX_MB EXPORT_WORKER_MAX_OBJECT_BYTES EXPORT_WORKER_MAX_JOB_BYTES'''.split()
COMMON_DEFAULTS = dict(LOG_LEVEL='info', FILE_GATEWAY_SECRET='', S3_REGION='garage',
                      S3_BUCKET_PUBLIC='pcu-public', S3_BUCKET_PROTECTED='pcu-protected',
                      S3_FORCE_PATH_STYLE='true', WEBGL_EXTERNAL_CONNECTIONS_ENABLED='false', WEBGL_PLAY_ENABLED='false')
API_DEFAULTS = dict(TRUST_PROXY='false', DOWNLOAD_AUTO_IP_BAN_ENABLED='false', SESSION_COOKIE_NAME='sid',
                    SESSION_IDLE_MS='7200000', SESSION_ABSOLUTE_MS='1209600000', SESSION_TOUCH_MIN_INTERVAL_MS='300000',
                    SHUTDOWN_DRAIN_MS='15000', COOKIE_SECURE='true', COOKIE_SAME_SITE='none', ALLOWED_GOOGLE_HD='')
PG_KEYS = 'POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD'.split()
PRIVATE_KEYS = COMMON_REQUIRED + PG_KEYS + list(COMMON_DEFAULTS) + list(API_DEFAULTS) + ['GOOGLE_CLIENT_SECRET', 'AUTH_SECRET']
TOPOLOGY = '''API_IMAGE DEPLOY_DIR API_BIND_HOST API_PORT NAS_EXPORT_HOST_PATH NAS_EXPORT_PATH
S3_TLS_CA_HOST_PATH APP_RUNTIME_ENV_FILE API_RUNTIME_ENV_FILE POSTGRES_RUNTIME_ENV_FILE'''.split()


def clean_env():
    # Resolve tool locations once; inherit no runtime configuration. Nix has no /bin/bash.
    directories = {str(Path(shutil.which(tool)).parent) for tool in ('bash', 'python3', 'env', 'dirname', 'grep')}
    return {'PATH': os.pathsep.join(sorted(directories)), 'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1'}


def directives(path):
    result = {}
    for line in path.read_text().splitlines():
        if '=' in line and not line.startswith('#'):
            name, setting = line.split('=', 1)
            result.setdefault(name, []).append(setting)
    return result


def decoded(text):
    return text.replace('%%', '%').replace('$$', '$')


def artifact_bytes(path):
    # Inspect the deliberately unreadable fixture without masking mode regressions
    # in renderer output or changing the operator-file fixture's permissions.
    mode = path.stat().st_mode & 0o777
    try:
        return path.read_bytes()
    except PermissionError:
        path.chmod(mode | 0o400)
        try:
            return path.read_bytes()
        finally:
            path.chmod(mode)


class Parity(unittest.TestCase):
    def render(self, root, output, overrides=None, extra=None):
        environment = clean_env() | {'DEPLOY_DIR': str(root), 'API_IMAGE': IMAGE}
        environment.update(overrides or {})
        environment.update(extra or {})
        return subprocess.run(['bash', str(HERE / 'render.sh'), str(output)], env=environment, capture_output=True, text=True)

    def assert_private_absent(self, root, sentinels, results=()):
        for result in results:
            self.assertTrue(all(secret not in result.stdout + result.stderr for secret in sentinels),
                            'private value in subprocess diagnostics')
        for path in root.rglob('*'):
            self.assertTrue(all(secret not in str(path) for secret in sentinels), 'private value in artifact path')
            if path.is_file():
                content = artifact_bytes(path)
                self.assertTrue(all(secret.encode() not in content for secret in sentinels),
                                'private value persisted in temporary tree')

    def scenario(self, overrides, sentinels=()):
        with tempfile.TemporaryDirectory(prefix='quadlet parity ') as temporary:
            root = Path(temporary)
            settings = {name: f'fixture-{name}' for name in COMMON_REQUIRED + PG_KEYS}
            settings.update(API_IMAGE=IMAGE, DATABASE_URL='postgresql://fixture:fixture@postgres:5432/fixture', RELEASE_SCHEMA_PHASE='phase2')
            settings.update(overrides)
            (root / '.env').write_text(''.join(f'{name}={shlex.quote(setting)}\n' for name, setting in settings.items()))
            output = root / 'rendered %$ units'
            result = self.render(root, output, {key: value for key, value in settings.items() if key in TOPOLOGY})
            self.assert_private_absent(root, sentinels, [result])
            self.assertEqual(result.returncode, 0, 'fixture topology render failed')
            entries = {
                'gp-api': 'dist/server.js', 'gp-worker-game-validation': 'dist/game-validation-worker.js',
                'gp-worker-webgl': 'dist/webgl-worker.js', 'gp-worker-video': 'dist/video-worker.js',
                'gp-worker-image': 'dist/image-worker.js', 'gp-worker-export': 'dist/export-worker.js',
                'gp-worker-project-publication': 'dist/project-publication-worker.js',
            }
            pod_def = directives(output / 'graduationproject.pod')
            self.assertEqual(decoded(pod_def['PublishPort'][0]), f"{settings.get('API_BIND_HOST', '127.0.0.1')}:{settings.get('API_PORT', '4000')}:4000")
            self.assertNotIn('ExitPolicy', pod_def)
            self.assertEqual(pod_def['PodmanArgs'], ['--exit-policy=continue'])
            self.assertEqual(pod_def['AddHost'], ['postgres:127.0.0.1'])
            self.assertEqual(pod_def['Restart'], ['on-failure'])
            self.assertEqual(pod_def['RestartSec'], ['15'])
            self.assertEqual(pod_def['StartLimitBurst'], ['10'])
            self.assertEqual(pod_def['StartLimitIntervalSec'], ['300'])
            self.assertEqual(pod_def['WantedBy'], ['default.target'])
            self.assertEqual(directives(output / 'gp-pg-data.volume')['VolumeName'], ['gp_pg_data'])
            for name in ['gp-postgres', *entries]:
                unit = directives(output / f'{name}.container')
                files = [decoded(shlex.split(item)[0]) for item in unit['EnvironmentFile']]
                expected_files = [str(root / 'runtime-env/postgres.env')] if name == 'gp-postgres' else [str(root / 'runtime-env/common.env')]
                if name == 'gp-api': expected_files.append(str(root / 'runtime-env/api.env'))
                self.assertEqual(files, expected_files)
                actual_env = dict(decoded(shlex.split(item)[0]).split('=', 1) for item in unit.get('Environment', []))
                expected_env = {} if name == 'gp-postgres' else {'NODE_ENV': 'production'}
                if name == 'gp-api': expected_env['PORT'] = '4000'
                if name == 'gp-worker-export': expected_env['NAS_EXPORT_ROOT'] = settings.get('NAS_EXPORT_PATH', '/nas')
                if name != 'gp-postgres' and settings.get('S3_TLS_CA_HOST_PATH'):
                    expected_env['NODE_EXTRA_CA_CERTS'] = '/run/secrets/garage-ca.pem'
                self.assertEqual(actual_env, expected_env, name)
                volumes = [decoded(setting) for setting in unit.get('Volume', [])]
                expected_volumes = ['gp-pg-data.volume:/var/lib/postgresql/data:Z'] if name == 'gp-postgres' else []
                if name == 'gp-worker-export':
                    expected_volumes.append(settings.get('NAS_EXPORT_HOST_PATH', '/mnt/nas/pcu_storage/GraduationGame') + ':' + settings.get('NAS_EXPORT_PATH', '/nas') + ':rw,Z')
                if name != 'gp-postgres' and settings.get('S3_TLS_CA_HOST_PATH'):
                    expected_volumes.append(settings['S3_TLS_CA_HOST_PATH'] + ':/run/secrets/garage-ca.pem:ro,Z')
                self.assertCountEqual(volumes, expected_volumes, name)
                tmpfs = {'gp-worker-game-validation': '6g', 'gp-worker-webgl': '6g', 'gp-worker-video': '2g', 'gp-worker-image': '512m'}
                self.assertEqual(unit.get('Tmpfs', []), ['/tmp:rw,noexec,nosuid,size=' + tmpfs[name]] if name in tmpfs else [])
                self.assertEqual(unit['ContainerName'], [name])
                self.assertEqual(unit['Pod'], ['graduationproject.pod'])
                self.assertEqual(unit['StartWithPod'], ['true'])
                self.assertEqual(unit['Image'], ['docker.io/library/postgres:16-alpine' if name == 'gp-postgres' else IMAGE])
                if name != 'gp-postgres':
                    self.assertEqual(unit['Entrypoint'], ['node'])
                    self.assertEqual(unit['Exec'], [entries[name]])
                    self.assertEqual(unit['After'], ['gp-postgres.service' if name == 'gp-api' else 'gp-api.service'])
                for dependency in ('Wants', 'Requires', 'BindsTo', 'PartOf', 'WantedBy'):
                    self.assertNotIn(dependency, unit)
                self.assertEqual(unit['StopTimeout'], ['10'])
                self.assertEqual(unit['Restart'], ['always'])
            self.assertEqual(len(list(output.iterdir())), 10)
            self.assertEqual(output.stat().st_mode & 0o777, 0o700)
            for path in output.iterdir(): self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            generator = select_generator()
            if generator:
                generated = root / 'generated-parity'
                generated.mkdir()
                result = generate(generator, output, generated, clean_env() | {'HOME': str(root)})
                self.assertEqual(result.returncode, 0, 'offline Quadlet generation failed')
                assert_graph(self, generated)

    def test_defaults(self): self.scenario({})

    def test_explicit_generator_cannot_silently_skip(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.dict(os.environ, {'QUADLET_GENERATOR': str(Path(temporary) / 'absent'),
                                         'QUADLET_EXPECT_VERSION': '5.4.2'}):
                with self.assertRaises(AssertionError):
                    select_generator()
        generator = select_generator()
        if generator:
            with patch.dict(os.environ, {'QUADLET_GENERATOR': generator,
                                         'QUADLET_EXPECT_VERSION': '0.0.0-invalid'}):
                with self.assertRaises(AssertionError):
                    select_generator()

    def test_542_rejects_native_exit_policy_key(self):
        generator = select_generator()
        if not generator:
            self.skipTest('native generator unavailable; CI requires explicit 5.4.2 verification')
        version = subprocess.run([generator, '--version'], capture_output=True, text=True, timeout=30)
        if version.stdout.strip() != '5.4.2':
            self.skipTest('unsupported-key regression is specific to Podman 5.4.2')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / 'rendered'
            self.assertEqual(self.render(root, output).returncode, 0)
            pod = output / 'graduationproject.pod'
            pod.write_text(pod.read_text().replace('PodmanArgs=--exit-policy=continue', 'ExitPolicy=continue'))
            generated = root / 'generated'
            generated.mkdir()
            result = generate(generator, output, generated, clean_env() | {'HOME': str(root)})
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("unsupported key 'ExitPolicy'", result.stderr)
            self.assertFalse((generated / 'graduationproject-pod.service').exists())

    def test_overrides_ca_and_paths(self):
        self.scenario({'API_BIND_HOST': '0.0.0.0', 'API_PORT': '4567',
                       'NAS_EXPORT_HOST_PATH': '/mnt/nas space %$d/storage', 'NAS_EXPORT_PATH': '/export space %$d',
                       'S3_TLS_CA_HOST_PATH': '/srv/ca space %$d.pem', 'LOG_LEVEL': 'debug', 'TRUST_PROXY': '10.0.0.1'})

    def test_harness_does_not_inherit_parent_secrets(self):
        sentinels = ['private-' + uuid.uuid4().hex for _ in PRIVATE_KEYS]
        with patch.dict(os.environ, dict(zip(PRIVATE_KEYS, sentinels))):
            self.scenario({}, sentinels)

    def test_opaque_runtime_and_parent_secrets(self):
        # Sentinels exist only in parent memory/environment, never in test input files.
        secret = 'private-' + uuid.uuid4().hex
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / '.env').write_text('exit 99\n')
            unreadable = root / 'opaque-runtime.env'
            unreadable.write_text('innocuous fixture content\n')
            unreadable.chmod(0)
            topology = {'APP_RUNTIME_ENV_FILE': str(unreadable), 'API_RUNTIME_ENV_FILE': str(root / 'absent-api.env'),
                        'POSTGRES_RUNTIME_ENV_FILE': str(root / 'absent-postgres.env')}
            injected = {name: secret for name in PRIVATE_KEYS}
            injected.update(PYTHONPATH=secret, BASH_ENV=secret, ENV=secret)
            first = self.render(root, root / 'first', topology, injected)
            second = self.render(root, root / 'second', topology)
            self.assertEqual(first.returncode, 0, 'render with inherited private values failed')
            self.assertEqual(second.returncode, 0, 'clean topology render failed')
            for path in (root / 'first').iterdir():
                self.assertTrue(path.read_bytes() == (root / 'second' / path.name).read_bytes(),
                                'render depends on inherited private configuration')
            # Inspect the native generator with a clean env too; never launch containers/services.
            generator = select_generator()
            results = [first, second]
            if generator:
                generated = root / 'generated'
                generated.mkdir()
                result = generate(generator, root / 'first', generated, clean_env() | {'HOME': str(root)})
                results.append(result)
                self.assert_private_absent(root, [secret], results)
                self.assertEqual(result.returncode, 0, 'offline Quadlet generation failed')
                self.assertEqual(len(list(generated.glob('*.service'))), 10)
                assert_graph(self, generated)
            self.assert_private_absent(root, [secret], results)
            self.assertTrue(artifact_bytes(unreadable) == b'innocuous fixture content\n', 'operator file changed')
            self.assertEqual(unreadable.stat().st_mode & 0o777, 0, 'operator file permissions changed')
            unit = directives(root / 'first/gp-postgres.container')
            self.assertEqual(unit['EnvironmentFile'], ['"' + str(root / 'absent-postgres.env') + '"'])
            self.assertEqual(len(list((root / 'first').iterdir())), 10)
            self.assertFalse(any(path.suffix == '.env' for path in (root / 'first').iterdir()))

    def test_rejects_invalid_topology_without_outputs(self):
        for overrides in ({'API_IMAGE': 'repository:latest'}, {'API_PORT': '65536'}, {'DEPLOY_DIR': 'relative'},
                          {'APP_RUNTIME_ENV_FILE': '/same', 'POSTGRES_RUNTIME_ENV_FILE': '/same'}):
            with self.subTest(overrides=overrides), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                result = self.render(root, root / 'output', overrides)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((root / 'output').exists())


if __name__ == '__main__': unittest.main()
