#!/usr/bin/env python3
"""Executable release fixtures. All systemctl/Podman calls are shell doubles."""
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
IMAGE = 'ghcr.io/pcugame/pcu-graduationproject-v2-api@sha256:' + 'a' * 64
OLD = IMAGE.replace('a' * 64, 'b' * 64)
APPS = ['gp-api', *['gp-worker-' + name for name in ('game-validation', 'webgl', 'video', 'image', 'export', 'project-publication')]]
MOCKS = r'''
HEALTHCHECK_TIMEOUT=4
sleep() { :; }
validate_capacity_boundaries() { echo capacity >> "$FIXTURE/log"; }
validate_release_artifacts() { echo artifact >> "$FIXTURE/log"; [[ "${FAIL:-}" != artifact ]]; }
podman() {
  echo "podman $*" >> "$FIXTURE/log"
  case "$1" in
    inspect)
      [[ "${FAIL:-}" != inspecterror ]] || return 125
      if [[ "${@: -1}" == gp-postgres ]]; then echo running
      elif [[ "${FAIL:-}" == inspect ]]; then echo paused
      else cat "$FIXTURE/${@: -1}"; fi ;;
    container) [[ "${FAIL:-}" != inspecterror ]] || return 125; [[ -f "$FIXTURE/$3" ]] ;;
    image)
      case "$*" in
        *'{{.Digest}}'*) echo "${API_IMAGE##*@}" ;;
        *org.opencontainers.image.revision*) echo "$RELEASE_SOURCE_SHA" ;;
      esac ;;
    exec)
      if [[ "${3:-}" == sh ]]; then
        [[ "${FAIL:-}" != backup ]] || return 31
        [[ "${FAIL:-}" == emptybackup ]] || echo fixture-dump
        return 0
      fi
      if [[ "$2" == gp-api ]]; then [[ "${FAIL:-}" != health ]] && echo '{"ok":true}'; fi ;;
    run)
      [[ "${FAIL:-}" != schema ]] || return 32
      if [[ "${@: -1}" == apply-contract ]]; then
        [[ "${FAIL:-}" != migration ]] || return 33
        echo contract-applied >> "$FIXTURE/log"
      fi ;;
    logs) : ;;
    *) echo 'forbidden podman mutation' >&2; return 90 ;;
  esac
}
systemctl() {
  echo "systemctl $*" >> "$FIXTURE/log"
  local verb="$2" unit="${3:-}"
  case "$verb" in
    show-environment)
      [[ "${FAIL:-}" != managerenv ]] || return 125
      [[ "${FAIL:-}" != managerdropin ]] || echo "QUADLET_UNIT_DIRS=$FIXTURE/alternate" ;;
    show)
      [[ "${FAIL:-}" != show ]] || return 125
      case "$4" in
        --property=SourcePath)
          [[ "${FAIL:-}" != generated ]] || { echo /legacy/service; return; }
          if [[ "$unit" == gp-pg-data-volume.service ]]; then echo "$QUADLET_DIR/gp-pg-data.volume"
          elif [[ "$unit" == graduationproject-pod.service ]]; then echo "$QUADLET_DIR/graduationproject.pod"
          else echo "$QUADLET_DIR/${unit%.service}.container"; fi ;;
        --property=NeedDaemonReload) [[ "${FAIL:-}" == pending ]] && echo yes || echo no ;;
        --property=DropInPaths) [[ "${FAIL:-}" != dropin ]] || echo /fixture/override.conf ;;
        --property=FragmentPath) echo "/run/user/999/systemd/generator/$unit" ;;
        --property=ActiveState) [[ "$(cat "$FIXTURE/${unit%.service}" 2>/dev/null || echo missing)" == running ]] && echo active || echo inactive ;;
      esac ;;
    is-active)
      [[ "${FAIL:-}" != inactive ]] || return 1
      [[ "${FAIL:-}" != podinactive || "$4" != graduationproject-pod.service ]] || return 1
      [[ "${FAIL:-}" != pginactive || "$4" != gp-postgres.service ]] || return 1 ;;
    daemon-reload) [[ "${FAIL:-}" != reload ]] ;;
    stop)
      [[ "${FAIL:-}" != stop ]] || return 23
      for unit in "${@:3}"; do
        if [[ "${FAIL:-}" == missingcontainers ]]; then rm -f "$FIXTURE/${unit%.service}"; else echo exited > "$FIXTURE/${unit%.service}"; fi
      done ;;
    start)
      [[ "${FAIL:-}" != start ]] || return 24
      echo running > "$FIXTURE/${unit%.service}" ;;
    *) return 91 ;;
  esac
}
case "$ACTION" in
up) do_up ;;
drain) do_drain ;;
down) do_down ;;
artifact) do_release_artifact_preflight phase2 ;;
backup) do_backup fixture ;;
assert) do_release_assert phase2 ;;
migrate) do_release_migration apply-contract ;;
esac
'''

class Deploy(unittest.TestCase):
    def run_fixture(self, action='up', failure='', overrides=None, drift=False, missing=False):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = root / 'runtime-env'
            runtime.mkdir()
            common = dict(DATABASE_URL='postgresql://fixture:fixture@postgres:5432/fixture',
                SESSION_SECRET='fixture', GOOGLE_CLIENT_IDS='fixture', CORS_ALLOWED_ORIGINS='https://web.example',
                API_PUBLIC_URL='https://api.example', WEB_PUBLIC_URL='https://web.example',
                S3_ENDPOINT='https://s3.example', S3_PUBLIC_SIGNING_ENDPOINT='https://upload.example',
                S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT='https://download.example', PUBLIC_ASSET_ORIGIN='https://public.example',
                S3_ACCESS_KEY_ID='fixture', S3_SECRET_ACCESS_KEY='fixture', FILE_GATEWAY_SECRET='x'*32,
                DIRECT_UPLOAD_PART_URL_REFRESH_MAX='64', UPLOAD_USER_GAME_MAX_MB='5120', UPLOAD_PRIVILEGED_GAME_MAX_MB='5120',
                DIRECT_UPLOAD_WORKER_TEMP_MAX_MB='6144', EXPORT_WORKER_MAX_OBJECT_BYTES='5368709120', EXPORT_WORKER_MAX_JOB_BYTES='34359738368')
            common.update(overrides or {})
            (runtime / 'common.env').write_text(''.join(f'{key}={value}\n' for key,value in common.items()))
            (runtime / 'api.env').write_text('TRUST_PROXY=false\n')
            (runtime / 'postgres.env').write_text('POSTGRES_USER=fixture\nPOSTGRES_DB=fixture\nPOSTGRES_PASSWORD=fixture\n')
            (root / '.env').write_text('RELEASE_SCHEMA_PHASE=phase2\nS3_PRIVATE_NETWORK_CONFIRMED=true\nAPI_IMAGE=stale:latest\nFILE_GATEWAY_SECRET=stale\n')
            if failure == 'runtime': (runtime / 'api.env').unlink()
            units = root / 'units'
            environment = dict(PATH=os.environ['PATH'], HOME=str(root), DEPLOY_DIR=str(root), API_IMAGE=OLD,
                MIGRATION_IMAGE=IMAGE, RELEASE_SOURCE_SHA='c'*40, FIXTURE=str(root), ACTION=action,
                FAIL=failure, QUADLET_DIR=str(units), PYTHONDONTWRITEBYTECODE='1')
            result = subprocess.run(['bash', str(HERE / 'render.sh'), str(units)], env=environment, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0)
            if failure == 'quadletdropin': (units / 'container.d').mkdir()
            if failure in ('externaldropin', 'managerdropin'):
                alternate = root / 'alternate'
                alternate.mkdir()
                (alternate / 'gp-.container.d').mkdir()
                environment['QUADLET_UNIT_DIRS'] = str(alternate)
            if drift: (units / 'gp-api.container').write_text((units / 'gp-api.container').read_text() + 'Environment=WRONG=true\n')
            if missing: (units / 'gp-worker-image.container').unlink()
            for name in APPS: (root / name).write_text('running\n')
            (root / 'log').touch()
            prefix = (HERE.parent / 'deploy.sh').read_text().split('# ── Main ')[0]
            # Source modules from the repository, never operator deployment files.
            prefix = prefix.replace('DEPLOY_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"',
                'DEPLOY_SCRIPT_DIR=' + str(HERE.parent))
            harness = root / 'harness.sh'
            harness.write_text(prefix + MOCKS)
            environment['API_IMAGE'] = IMAGE
            if failure == 'immutable': environment['API_IMAGE']='repo:latest'
            if action == 'release':
                # Execute the same external-process gates as Deploy Release. The
                # workflow's web/approval/audit steps remain covered by its tests.
                environment['HARNESS'] = str(harness)
                command = ['bash', '-ec', '\n'.join(
                    f'ACTION={stage} bash "$HARNESS"' for stage in
                    ('artifact', 'assert', 'drain', 'backup', 'migrate', 'up'))]
            else:
                command = ['bash', str(harness)]
            result = subprocess.run(command, env=environment, capture_output=True, text=True)
            log = (root / 'log').read_text().splitlines()
            marker = (root / 'cutover-state/mutation-drained').exists()
            images = [(units / f'{name}.container').read_text().split('Image=')[1].splitlines()[0] for name in APPS if (units / f'{name}.container').exists()]
            return result, log, marker, images

    def test_release_success_orders_dump_contract_and_activation(self):
        result, log, marker, images = self.run_fixture('release')
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        dump = next(i for i, line in enumerate(log) if 'pg_dump' in line)
        contract = log.index('contract-applied')
        activation = log.index('systemctl --user daemon-reload')
        self.assertTrue(dump < contract < activation)
        self.assertEqual(images, [IMAGE] * 7)
        self.assertFalse(marker)

    def test_release_failure_gates(self):
        for failure in ('artifact', 'backup', 'emptybackup', 'migration'):
            with self.subTest(failure=failure):
                result, log, marker, images = self.run_fixture('release', failure)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('contract-applied', log)
                self.assertFalse(any(line.startswith('systemctl --user start') for line in log))
                self.assertTrue(all(image == OLD for image in images))
                dump = [line for line in log if 'pg_dump' in line]
                migration = [line for line in log if line.endswith(' apply-contract')]
                if failure == 'artifact':
                    self.assertFalse(marker)
                    self.assertFalse(dump)
                    self.assertFalse(any(line.startswith('systemctl --user stop') for line in log))
                elif failure in ('backup', 'emptybackup'):
                    self.assertTrue(marker)
                    self.assertEqual(len(dump), 1)
                    self.assertFalse(migration)
                else:
                    self.assertEqual(len(migration), 1)

    def test_contract_activation_failure_never_restores_old_image(self):
        for failure in ('reload', 'start', 'health'):
            with self.subTest(failure=failure):
                result, log, marker, images = self.run_fixture('release', failure)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('contract-applied', log)
                self.assertEqual(images, [IMAGE] * 7)
                self.assertFalse(marker)
                self.assertFalse(any(line.startswith('systemctl --user start gp-worker') for line in log))
                self.assertFalse(any(OLD in line for line in log))

    def test_up_order_and_retained_pg(self):
        result, log, marker, images = self.run_fixture()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        reload = log.index('systemctl --user daemon-reload')
        stop = next(i for i,line in enumerate(log) if line.startswith('systemctl --user stop '))
        schema = next(i for i,line in enumerate(log) if line.startswith('podman run '))
        api = log.index('systemctl --user start gp-api.service')
        health = next(i for i,line in enumerate(log) if line.startswith('podman exec gp-api '))
        worker = log.index('systemctl --user start gp-worker-game-validation.service')
        self.assertTrue(stop < reload < schema < api < health < worker)
        self.assertFalse(marker)
        self.assertEqual(images, [IMAGE]*7)
        self.assertTrue(all('gp-postgres.service' not in line and 'graduationproject-pod.service' not in line for line in log if line.startswith(('systemctl --user start', 'systemctl --user stop'))))
        self.assertIn('-e DATABASE_URL=postgresql://fixture:fixture@postgres:5432/fixture', log[schema])

    def test_drain_and_down_systemd_only(self):
        for action in ('drain', 'down'):
            result, log, marker, _ = self.run_fixture(action)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            self.assertEqual(marker, action == 'drain')
            stops = [line for line in log if line.startswith('systemctl --user stop')]
            self.assertEqual(len(stops), 1 if action == 'drain' else 3)
            if action == 'down':
                self.assertEqual(stops[-2:], ['systemctl --user stop gp-postgres.service', 'systemctl --user stop graduationproject-pod.service'])

    def test_pre_mutation_failures(self):
        for kwargs in ({'failure':'immutable'}, {'failure':'runtime'}, {'failure':'show'}, {'overrides':{'PULL_API_IMAGE':'false'}}, {'overrides':{'NODE_ENV':'development'}}, {'overrides':{'IFS':'danger'}}, {'failure':'generated'}, {'failure':'pending'}, {'failure':'dropin'}, {'failure':'quadletdropin'}, {'failure':'externaldropin'}, {'failure':'managerdropin'}, {'failure':'managerenv'}, {'failure':'inactive'}, {'failure':'podinactive'}, {'failure':'pginactive'}, {'failure':'artifact'}, {'drift':True}, {'missing':True}, {'overrides':{'S3_ENDPOINT':'http://invalid.example'}}):
            with self.subTest(kwargs=kwargs):
                result,log,marker,images = self.run_fixture(**kwargs)
                self.assertNotEqual(result.returncode,0)
                self.assertFalse(any(line.startswith(('systemctl --user stop', 'systemctl --user start', 'systemctl --user daemon-reload')) for line in log))
                self.assertFalse(marker)
                self.assertTrue(all(image == OLD for image in images))

    def test_transaction_failures_do_not_start_workers(self):
        for failure in ('reload','stop','schema','health','start','inspect'):
            with self.subTest(failure=failure):
                result,log,marker,_ = self.run_fixture(failure=failure)
                self.assertNotEqual(result.returncode,0)
                self.assertFalse(any(line.startswith('systemctl --user start gp-worker') for line in log))
                self.assertFalse(marker)

    def test_failed_drain_never_marks(self):
        for failure in ('stop','inspect','inspecterror'):
            result,_,marker,_ = self.run_fixture('drain', failure)
            self.assertNotEqual(result.returncode,0)
            self.assertFalse(marker)

    def test_artifact_preflight_rejects_unadopted_host(self):
        result,log,_,_ = self.run_fixture('artifact', missing=True)
        self.assertNotEqual(result.returncode,0)
        self.assertNotIn('artifact',log)

if __name__ == '__main__': unittest.main()
