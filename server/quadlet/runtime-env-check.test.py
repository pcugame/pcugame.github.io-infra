#!/usr/bin/env python3
"""Offline fixtures exercise comparison boundaries without running Podman."""
import copy
import json
from pathlib import Path
import runpy
import re
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
RUNTIME = runpy.run_path(str(HERE / 'runtime-env.py'))
CHECK = runpy.run_path(str(HERE / 'runtime-env-check.py'))
SENTINEL = 'PRIVATE_SENTINEL_$(never_execute)=https://private.invalid/token'
UNKNOWN = 'PRIVATE_UNKNOWN_NAME_SENTINEL'


class RuntimeCheck(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.addCleanup(self.directory.cleanup)
        self.scopes = [{key: SENTINEL + '-' + key for key in sorted(keys)} for keys in RUNTIME['SCOPES']]
        self.scopes[0]['DATABASE_URL'] = 'postgresql://fixture:PRIVATE_PASSWORD@postgres:5432/db?application_name=a%2Fb#fragment'
        self.scopes[0]['FILE_GATEWAY_SECRET'] = ''
        self.scopes[1]['ALLOWED_GOOGLE_HD'] = ''
        self.paths = [self.root / (name + '.env') for name in ('common', 'api', 'postgres')]
        self.write_files()
        self.document = []
        for name in CHECK['NAMES']:
            values = dict(self.scopes[2]) if name == 'gp-postgres' else self.scopes[0] | {'NODE_ENV': 'production'}
            if name == 'gp-api':
                values.update(self.scopes[1] | {'PORT': '4000'})
            if name == 'gp-worker-export':
                values['NAS_EXPORT_ROOT'] = '/nas'
            values['PATH'] = '/usr/local/bin:/usr/bin'
            values[UNKNOWN] = SENTINEL
            self.document.append({'Name': '/' + name, 'State': {'Running': True},
                                  'Config': {'Env': [key + '=' + value for key, value in values.items()]}})

    def write_files(self):
        for path, values in zip(self.paths, self.scopes):
            path.write_text('# fixture\n' + '\n'.join(key + '=' + value for key, value in values.items()) + '\n')

    def run_check(self, document=None, raw=None, options=(), paths=None):
        before = {str(path): path.read_bytes() for path in self.root.rglob('*') if path.is_file()}
        result = subprocess.run([sys.executable, str(HERE / 'runtime-env-check.py'),
                                 *map(str, paths or self.paths), *options],
                                input=raw if raw is not None else json.dumps(document if document is not None else self.document),
                                text=True, capture_output=True)
        output = result.stdout + result.stderr
        for secret in (SENTINEL, UNKNOWN, 'PRIVATE_PASSWORD', 'private.invalid'):
            self.assertNotIn(secret, output)
        self.assertNotIn('Traceback', output)
        after = {str(path): path.read_bytes() for path in self.root.rglob('*') if path.is_file()}
        self.assertEqual(before, after, 'read-only helper changed fixture files')
        return result

    def change(self, index, key, value=None):
        env = self.document[index]['Config']['Env']
        env[:] = [entry for entry in env if not entry.startswith(key + '=')]
        if value is not None:
            env.append(key + '=' + value)

    def test_all_containers_literal_empty_and_inherited_values(self):
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr)
        for name in CHECK['NAMES']:
            self.assertIn(name + ' ', result.stdout)
        self.assertIn('gp-api FILE_GATEWAY_SECRET equal', result.stdout)
        self.assertIn('gp-api ALLOWED_GOOGLE_HD equal', result.stdout)
        self.assertIn('gp-api NODE_EXTRA_CA_CERTS absent', result.stdout)
        self.assertIn('database connectivity is unverified', result.stdout)
        # Deployment retains shell-quoted output and defaults, adoption needs explicit values.
        self.paths[0].write_text('\n'.join(key + '=' + value for key, value in self.scopes[0].items()
                                        if key not in RUNTIME['COMMON_DEFAULTS']))
        deployment = RUNTIME['deployment_values'](self.paths)
        self.assertEqual(deployment['LOG_LEVEL'], 'info')
        self.assertEqual(self.run_check().returncode, 2)

    def test_application_key_inventory_tracks_schema_and_direct_reads(self):
        source = HERE.parents[1] / 'apps' / 'api' / 'src'
        schema = (source / 'config' / 'env.ts').read_text()
        fields = schema.split('.object({', 1)[1].split('.superRefine', 1)[0]
        keys = set(re.findall(r'^\s+([A-Z][A-Z0-9_]*)\s*:', fields, re.MULTILINE))
        self.assertTrue(keys, 'schema inventory extraction found no keys')
        self.assertEqual(CHECK['APP_SCHEMA_KEYS'], keys)
        direct = set()
        for path in source.rglob('*.ts'):
            if ('generated' in path.parts or '__tests__' in path.parts
                    or path.name.endswith('.test.ts')):
                continue
            text = path.read_text()
            direct.update(re.findall(r'process\.env\.([A-Z][A-Z0-9_]*)', text))
            direct.update(re.findall(r"process\.env\[\s*['\"]([A-Z][A-Z0-9_]*)['\"]\s*\]", text))
        self.assertEqual(CHECK['APP_PROCESS_ENV_KEYS'], direct - keys)

    def test_multiline_image_defaults_do_not_block_runtime_comparison(self):
        self.change(7, 'DOCKER_PG_LLVM_DEPS', '\n\tllvm19-dev\n\tclang19\n' + SENTINEL)
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('DOCKER_PG_LLVM_DEPS', result.stdout)
        self.change(7, 'POSTGRES_PASSWORD', 'changed')
        result = self.run_check()
        self.assertEqual(result.returncode, 1)
        self.assertIn('gp-postgres POSTGRES_PASSWORD different', result.stdout)

    def test_control_characters_in_runtime_inventory_still_fail_closed(self):
        for key in sorted(CHECK['KNOWN']):
            with self.subTest(key=key):
                original = copy.deepcopy(self.document)
                self.change(0, key, SENTINEL + '\nsecond-line')
                result = self.run_check()
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, '')
                self.document = original
        self.change(7, 'DOCKER_PG_LLVM_DEPS', SENTINEL + '\0')
        self.assertEqual(self.run_check().returncode, 2)

    def test_unpreserved_application_overrides_block_comparison(self):
        for index, key, value in ((0, 'RATE_LIMIT_LOGIN_MAX', '3'),
                                  (5, 'EXPORT_WORKER_FILE_CONCURRENCY', '1')):
            original = copy.deepcopy(self.document)
            self.change(index, key, value)
            result = self.run_check()
            self.assertEqual(result.returncode, 1)
            self.assertIn(f"{CHECK['NAMES'][index]} {key} unexpected", result.stdout)
            # Detection must not silently expand the runtime-file contract.
            self.paths[0].write_text(self.paths[0].read_text() + key + '=' + value + '\n')
            self.assertEqual(self.run_check().returncode, 2)
            self.write_files()
            self.document = original
        # Every schema-supported unpreserved key fails closed, even if its
        # explicit value happens to equal an application's current default.
        preserved = set().union(*RUNTIME['SCOPES'], CHECK['RESERVED'])
        for key in sorted(CHECK['APP_SCHEMA_KEYS'] - preserved):
            self.change(0, key, SENTINEL)
            result = self.run_check()
            self.assertEqual(result.returncode, 1, key)
            self.assertIn(f'gp-api {key} unexpected', result.stdout)
            self.change(0, key)

    def test_expected_values_on_every_container(self):
        for index, name in enumerate(CHECK['NAMES']):
            with self.subTest(name=name):
                original = copy.deepcopy(self.document)
                key = 'POSTGRES_PASSWORD' if name == 'gp-postgres' else 'SESSION_SECRET'
                self.change(index, key)
                result = self.run_check()
                self.assertEqual(result.returncode, 1)
                self.assertIn(f'{name} {key} missing', result.stdout)
                self.change(index, key, 'PRIVATE_PASSWORD')
                result = self.run_check()
                self.assertEqual(result.returncode, 1)
                self.assertIn(f'{name} {key} different', result.stdout)
                self.document = original

    def test_reserved_settings_and_wrong_container_scopes(self):
        for index, name in enumerate(CHECK['NAMES']):
            keys = ['NODE_ENV'] if name != 'gp-postgres' else ['POSTGRES_USER']
            if name == 'gp-api': keys += ['PORT']
            if name == 'gp-worker-export': keys += ['NAS_EXPORT_ROOT']
            for key in keys:
                with self.subTest(name=name, key=key):
                    original = copy.deepcopy(self.document)
                    self.change(index, key, SENTINEL)
                    result = self.run_check()
                    self.assertEqual(result.returncode, 1)
                    self.assertIn(f'{name} {key} different', result.stdout)
                    self.document = original
            wrong = 'SESSION_SECRET' if name == 'gp-postgres' else 'POSTGRES_PASSWORD'
            self.change(index, wrong, SENTINEL)
            result = self.run_check()
            self.assertEqual(result.returncode, 1)
            self.assertIn(f'{name} {wrong} unexpected', result.stdout)
            self.change(index, wrong)

    def test_optional_ca_is_checked_in_every_app_and_absent_elsewhere(self):
        self.assertEqual(self.run_check(options=['--garage-ca']).returncode, 1)
        for index, name in enumerate(CHECK['APP_NAMES']):
            self.change(index, 'NODE_EXTRA_CA_CERTS', '/run/secrets/garage-ca.pem')
        self.assertEqual(self.run_check(options=['--garage-ca']).returncode, 0)
        self.assertEqual(self.run_check().returncode, 1)
        for index, name in enumerate(CHECK['APP_NAMES']):
            self.change(index, 'NODE_EXTRA_CA_CERTS', SENTINEL)
            result = self.run_check(options=['--garage-ca'])
            self.assertIn(f'{name} NODE_EXTRA_CA_CERTS different', result.stdout)
            self.change(index, 'NODE_EXTRA_CA_CERTS', '/run/secrets/garage-ca.pem')
        self.change(7, 'NODE_EXTRA_CA_CERTS', '/run/secrets/garage-ca.pem')
        self.assertEqual(self.run_check(options=['--garage-ca']).returncode, 1)

    def test_custom_nas_root(self):
        self.change(5, 'NAS_EXPORT_ROOT', '/exports')
        self.assertEqual(self.run_check().returncode, 1)
        self.assertEqual(self.run_check(options=['--nas-export-root', '/exports']).returncode, 0)
        for path in (SENTINEL, '/bad:path', '/bad\\path', '/bad\npath', '/bad '):
            self.assertEqual(self.run_check(options=['--nas-export-root', path]).returncode, 2)

    def test_loopback_status_requires_all_other_database_url_bytes_identical(self):
        expected = self.scopes[0]['DATABASE_URL']
        transformed = expected.replace('@postgres:', '@127.0.0.1:')
        for index, name in enumerate(CHECK['APP_NAMES']):
            self.change(index, 'DATABASE_URL', transformed)
        result = self.run_check()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.count('DATABASE_URL postgres-loopback-equivalent'), 7)
        for bad in (transformed.replace('5432', '5433'), transformed.replace('/db?', '/other?'),
                    transformed.replace('PRIVATE_PASSWORD', 'other'), transformed.replace('a%2Fb', 'a/b'),
                    transformed.replace('#fragment', ''), transformed.replace('127.0.0.1', 'localhost')):
            self.change(0, 'DATABASE_URL', bad)
            self.assertEqual(self.run_check().returncode, 1)
        self.assertFalse(CHECK['postgres_loopback_equivalent']('postgresql://user@postgres:bad/db', 'postgresql://user@127.0.0.1:bad/db'))

    def test_missing_duplicate_unknown_reserved_wrong_scope_and_malformed_files(self):
        for scope in range(3):
            original = self.paths[scope].read_text()
            key = next(iter(self.scopes[scope]))
            cases = [original.replace(key + '=' + self.scopes[scope][key] + '\n', ''),
                     original + key + '=' + SENTINEL + '\n', original + UNKNOWN + '=' + SENTINEL,
                     original + 'NODE_ENV=' + SENTINEL, original + ' export SECRET=' + SENTINEL,
                     original + 'KEY_WITHOUT_EQUAL', original + 'LOG_LEVEL=trailing ',
                     original + 'LOG_LEVEL=bad\0' + SENTINEL]
            wrong = 'POSTGRES_USER' if scope != 2 else 'SESSION_SECRET'
            cases.append(original + wrong + '=' + SENTINEL)
            for content in cases:
                with self.subTest(scope=scope):
                    self.paths[scope].write_text(content)
                    result = self.run_check()
                    self.assertEqual(result.returncode, 2)
                    self.assertEqual(result.stdout, '')
            self.paths[scope].write_text(original)
        self.assertEqual(self.run_check(paths=[self.root / SENTINEL.replace('/', '_'), *self.paths[1:]]).returncode, 2)

    def test_malformed_inspect_fails_closed_and_suppresses_all_input(self):
        cases = [None, {}, [], self.document[:-1], self.document + [self.document[0]],
                 'PRIVATE_PASSWORD', {'error': SENTINEL}]
        for mutation in ('name', 'duplicate-name', 'stopped', 'env-type', 'env-entry', 'duplicate-env', 'config', 'state'):
            doc = copy.deepcopy(self.document)
            if mutation == 'name': doc[0]['Name'] = UNKNOWN
            if mutation == 'duplicate-name': doc[0]['Name'] = doc[1]['Name']
            if mutation == 'stopped': doc[0]['State']['Running'] = False
            if mutation == 'env-type': doc[0]['Config']['Env'] = SENTINEL
            if mutation == 'env-entry': doc[0]['Config']['Env'].append(SENTINEL)
            if mutation == 'duplicate-env': doc[0]['Config']['Env'].append('PATH=' + SENTINEL)
            if mutation == 'config': doc[0]['Config'] = None
            if mutation == 'state': doc[0]['State']['Running'] = 'true'
            cases.append(doc)
        for document in cases:
            result = self.run_check(raw=json.dumps(document))
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, '')
        for raw in (SENTINEL, '[NaN]', '[Infinity]', '{"Name":"' + UNKNOWN + '","Name":"PRIVATE_PASSWORD"}', '[' * 2000):
            self.assertEqual(self.run_check(raw=raw).returncode, 2)
        self.assertEqual(self.run_check(options=['--' + UNKNOWN, SENTINEL]).returncode, 2)


if __name__ == '__main__':
    unittest.main()
