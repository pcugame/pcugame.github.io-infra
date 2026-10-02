#!/usr/bin/env python3
"""Offline deploy.sh structural parity with innocuous fixtures and process doubles."""
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import unittest
import uuid
from unittest.mock import patch

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
            fixture_home = root / 'home'
            fixture_home.mkdir()
            environment = clean_env() | {'HOME': str(fixture_home), 'CUTOVER_STATE_DIR': str(root / 'cutover-state'),
                                         'DEPLOY_DIR': str(root), 'QUADLET_TEST_LOG': str(root / 'commands.jsonl')}
            prefix = DEPLOY.read_text().split('# ── Main ')[0]
            harness = root / 'capture.sh'
            harness.write_text(prefix + '''
validate_production_boundaries() { :; }
validate_capacity_boundaries() { :; }
validate_release_artifacts() { :; }
require_immutable_release_images() { :; }
verify_running() { :; }
wait_for_pg() { :; }
sleep() { :; }
mkdir() { :; }
mv() { :; }
sed() { :; }
rm() { :; }
systemctl() { :; }
podman() {
  python3 - "$@" <<'PY'
import json, os, sys
with open(os.environ['QUADLET_TEST_LOG'], 'a') as log:
    log.write(json.dumps(sys.argv[1:]) + '\\n')
PY
  case "$1 $2" in
    'exec gp-api') echo '{"ok":true}' ;;
    'pod exists') return 1 ;;
  esac
}
do_up
''')
            captured = subprocess.run(['bash', str(harness)], cwd=root, env=environment, capture_output=True, text=True)
            self.assert_private_absent(root, sentinels, [captured])
            self.assertEqual(captured.returncode, 0, 'fixture deployment harness failed')
            output = root / 'rendered %$ units'
            result = self.render(root, output, {key: value for key, value in settings.items() if key in TOPOLOGY})
            self.assert_private_absent(root, sentinels, [captured, result])
            self.assertEqual(result.returncode, 0, 'fixture topology render failed')
            commands = [json.loads(line) for line in (root / 'commands.jsonl').read_text().splitlines()]
            runs = [command for command in commands if command[:2] == ['run', '-d']]
            self.assertEqual(len(runs), 8)
            pod = next(command for command in commands if command[:2] == ['pod', 'create'])
            pod_def = directives(output / 'graduationproject.pod')
            self.assertEqual(decoded(pod_def['PublishPort'][0]), pod[pod.index('-p') + 1])
            self.assertEqual(pod_def['ExitPolicy'], ['continue'])
            self.assertEqual(pod_def['AddHost'], ['postgres:127.0.0.1'])
            self.assertEqual(pod_def['Restart'], ['on-failure'])
            self.assertEqual(pod_def['RestartSec'], ['15'])
            self.assertEqual(pod_def['StartLimitBurst'], ['10'])
            self.assertEqual(pod_def['StartLimitIntervalSec'], ['300'])
            self.assertEqual(pod_def['WantedBy'], ['default.target'])
            self.assertEqual(directives(output / 'gp-pg-data.volume')['VolumeName'], ['gp_pg_data'])
            common = {name: settings[name] for name in COMMON_REQUIRED}
            common.update({name: settings.get(name) or default for name, default in COMMON_DEFAULTS.items()})
            # deploy.sh rewrites this innocent fixture URL; Quadlet preserves it and uses the pod hosts alias.
            common['DATABASE_URL'] = common['DATABASE_URL'].replace('@postgres:', '@127.0.0.1:')
            api = {name: settings.get(name) or default for name, default in API_DEFAULTS.items()}
            file_contracts = {str(root / 'runtime-env/common.env'): common,
                              str(root / 'runtime-env/api.env'): api,
                              str(root / 'runtime-env/postgres.env'): {name: settings[name] for name in PG_KEYS}}
            for run in runs:
                name = run[run.index('--name') + 1]
                unit = directives(output / f'{name}.container')
                expected_env, expected_volumes, expected_tmpfs = {}, [], []
                for index, argument in enumerate(run):
                    if argument == '-e':
                        key, setting = run[index + 1].split('=', 1)
                        expected_env[key] = setting
                    elif argument == '-v': expected_volumes.append(run[index + 1])
                    elif argument == '--tmpfs': expected_tmpfs.append(run[index + 1])
                actual_env = {}
                files = [decoded(shlex.split(item)[0]) for item in unit['EnvironmentFile']]
                expected_files = [str(root / 'runtime-env/postgres.env')] if name == 'gp-postgres' else [str(root / 'runtime-env/common.env')]
                if name == 'gp-api': expected_files.append(str(root / 'runtime-env/api.env'))
                self.assertEqual(files, expected_files)
                for file in files: actual_env.update(file_contracts[file])
                for item in unit.get('Environment', []):
                    key, setting = decoded(shlex.split(item)[0]).split('=', 1)
                    actual_env[key] = setting
                self.assertEqual(actual_env, expected_env, name)
                volumes = [decoded(setting).replace('gp-pg-data.volume:', 'gp_pg_data:') for setting in unit.get('Volume', [])]
                self.assertEqual(volumes, expected_volumes, name)
                self.assertEqual(unit.get('Tmpfs', []), expected_tmpfs, name)
                self.assertEqual(unit['ContainerName'], [name])
                self.assertEqual(unit['Pod'], ['graduationproject.pod'])
                self.assertEqual(unit['StartWithPod'], ['true'])
                self.assertEqual(unit['Image'], [run[-1] if name == 'gp-postgres' else run[-2]])
                if name != 'gp-postgres':
                    self.assertEqual(unit['Entrypoint'], [run[run.index('--entrypoint') + 1]])
                    self.assertEqual(unit['Exec'], [run[-1]])
                    self.assertEqual(unit['After'], ['gp-postgres.service' if name == 'gp-api' else 'gp-api.service'])
                for dependency in ('Wants', 'Requires', 'BindsTo', 'PartOf', 'WantedBy'):
                    self.assertNotIn(dependency, unit)
                self.assertEqual(unit['StopTimeout'], ['10'])
                self.assertEqual(unit['Restart'], ['always'])
            self.assertEqual(len(list(output.iterdir())), 10)
            self.assertEqual(output.stat().st_mode & 0o777, 0o700)
            for path in output.iterdir(): self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_defaults(self): self.scenario({})

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
            explicit = os.environ.get('QUADLET_GENERATOR')
            candidates = [explicit] if explicit else [shutil.which('quadlet'),
                '/usr/libexec/podman/quadlet', '/usr/lib/podman/quadlet',
                '/usr/lib/systemd/system-generators/podman-system-generator',
                '/run/current-system/sw/libexec/podman/quadlet']
            generator = next((path for path in candidates if path and Path(path).is_file()), None)
            results = [first, second]
            if explicit:
                self.assertTrue(generator is not None, 'configured Quadlet generator unavailable')
            if generator:
                generated = root / 'generated'
                generated.mkdir()
                environment = clean_env() | {'HOME': str(root), 'QUADLET_UNIT_DIRS': str(root / 'first')}
                result = subprocess.run([generator, '--user', str(generated)], env=environment,
                                        capture_output=True, text=True)
                results.append(result)
                self.assert_private_absent(root, [secret], results)
                self.assertEqual(result.returncode, 0, 'offline Quadlet generation failed')
                self.assertEqual(len(list(generated.glob('*.service'))), 10)
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
