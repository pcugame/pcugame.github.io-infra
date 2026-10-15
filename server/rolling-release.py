#!/usr/bin/env python3
"""Resumable, forward-only API slot and worker handoff. No failure cleanup."""
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

WORKERS = ['gp-worker-' + kind for kind in (
    'game-validation', 'webgl', 'video', 'image', 'export', 'project-publication')]
IMAGE = r'ghcr\.io/pcugame/pcu-graduationproject-v2-api@sha256:[0-9a-f]{64}'


def save(path, value):
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.tmp')
    with temp.open('w') as file:
        os.chmod(temp, 0o600)
        file.write(value if isinstance(value, str) else json.dumps(value, indent=2) + '\n')
        file.flush()
        os.fsync(file.fileno())
    os.replace(temp, path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def idle(status):
    if status.get('kind') == 'worker':
        return status.get('paused') is True and status.get('active') == 0
    maintenance = status.get('maintenance', {})
    return (status.get('kind') == 'api' and status.get('accepting') is False
            and status.get('requests') == 0 and status.get('handlers') == 0
            and maintenance.get('paused') is True and maintenance.get('active') == 0
            and maintenance.get('error') is False)


class Deferred(Exception):
    pass


class Release:
    def __init__(self, host, state_file, sha, image, observe=600):
        if not re.fullmatch('[0-9a-f]{40}', sha) or not re.fullmatch(IMAGE, image):
            raise ValueError('Exact source SHA and immutable release image are required')
        self.host, self.file, self.sha, self.image = host, Path(state_file), sha, image
        self.observe = observe
        self.state = json.loads(self.file.read_text()) if self.file.exists() else None
        if self.state and self.state['phase'] != 'complete':
            if (self.state['sha'], self.state['image']) != (sha, image):
                raise ValueError('An unfinished release blocks another release')
        elif not self.state or (self.state['sha'], self.state['image']) != (sha, image):
            active = host.active_slot()
            self.state = dict(sha=sha, image=image, old=active, new='b' if active == 'a' else 'a',
                              phase='preflight', workers=[], deferred=False)
            self.persist()

    def persist(self, **values):
        self.state.update(values)
        save(self.file, self.state)

    def wait(self, predicate):
        deadline = time.monotonic() + self.observe
        while not predicate():
            if time.monotonic() >= deadline:
                self.persist(deferred=True)
                raise Deferred('Cleanup deferred; all processes retained. Resume this exact release.')
            time.sleep(1)
        self.persist(deferred=False)

    def run(self):
        h, s = self.host, self.state
        old, new = 'gp-api-' + s['old'], 'gp-api-' + s['new']
        # Verify actual process/artifact identities on every invocation.
        h.reconcile(s)
        if s['phase'] == 'preflight':
            h.preflight(s)
            h.snapshot(self.sha)
            self.persist(phase='candidate')
        if s['phase'] == 'candidate':
            self.persist(candidate_selected=True)
            h.start_candidate(s)
            h.probe('candidate', s)
            # Persist the entire old worker generation BEFORE changing disk or reload.
            self.persist(phase='switch', nginx_workers=h.nginx_workers(), boot_id=Path('/proc/sys/kernel/random/boot_id').read_text().strip())
        if s['phase'] == 'switch':
            # Re-probe on resume, including a restart that reset candidate state.
            h.probe('candidate', s)
            self.persist(nginx_workers=[list(worker) for worker in sorted({tuple(worker) for worker in [*s['nginx_workers'], *h.nginx_workers()]})])
            h.switch(s)
            h.probe('public', s)
            h.probe('nas-public', s)
            h.probe('nas-protected', s)
            h.set_active(s['new'])
            self.persist(phase='drain')
        if s['phase'] == 'drain':
            # Old nginx workers can still send old client requests. Keep HTTP open.
            h.pause_maintenance(s['old'])
            h.control(old, 'quiesce', 'maintenance')
            self.wait(lambda: s.get('boot_id') != Path('/proc/sys/kernel/random/boot_id').read_text().strip() or h.nginx_workers_gone(s['nginx_workers']))
            h.control(old, 'quiesce')
            self.wait(lambda: idle(h.control(old, 'status')))
            self.persist(phase='handoff')
        if s['phase'] == 'handoff':
            # Repeat quiesce after any restart; never infer idle from a persisted flag.
            if h.running(old):
                h.control(old, 'quiesce')
                self.wait(lambda: idle(h.control(old, 'status')))
                h.stop(old)
            h.enable_maintenance(s)
            self.wait(lambda: h.maintenance_ready(s))
            self.persist(phase='workers')
        if s['phase'] == 'workers':
            h.enable_maintenance(s)
            self.wait(lambda: h.maintenance_ready(s))
            for worker in WORKERS:
                if worker in s['workers']:
                    h.verify_image(worker, self.image, self.sha)
                    continue
                if h.running(worker):
                    h.control(worker, 'quiesce')
                    self.wait(lambda: idle(h.control(worker, 'status')))
                    h.stop(worker)
                self.persist(replacing_worker=worker)
                h.replace_worker(worker, s)
                self.persist(workers=[*s['workers'], worker], replacing_worker=None)
            h.verify_runtime(s)
            self.persist(phase='web-pending')
        if s['phase'] == 'web-pending':
            h.verify_runtime(s)
        return s


class Host:
    def __init__(self, root):
        self.root = Path(root)
        self.config = json.loads((self.root / 'rolling-installation.json').read_text())
        self.quadlet = Path(self.config['quadlet_dir'])

    def command(self, args):
        return subprocess.check_output(args, text=True).strip()

    def active_slot(self):
        slot = (self.root / 'cutover-state/active-slot').read_text().strip()
        if slot not in ('a', 'b'):
            raise ValueError('Invalid installed active slot')
        return slot

    def set_active(self, slot):
        save(self.root / 'cutover-state/active-slot', slot + '\n')

    def control(self, name, command, scope='all'):
        return json.loads(self.command(['podman', 'exec', name, 'node',
                                       'dist/infrastructure/runtime-control.js', command, scope]))

    def inspect(self, name):
        return json.loads(self.command(['podman', 'inspect', name]))[0]

    def running(self, name):
        code = subprocess.run(['podman', 'container', 'exists', name], check=False).returncode
        if code == 1:
            return False
        if code != 0:
            raise ValueError('Cannot determine container existence')
        return self.inspect(name)['State']['Status'] == 'running'

    def verify_image(self, name, image, sha=None):
        info = self.inspect(name)
        meta = json.loads(self.command(['podman', 'image', 'inspect', info['Image']]))[0]
        if info['State']['Status'] != 'running' or meta['Digest'] != image.split('@')[1]:
            raise ValueError('Runtime image/state mismatch: ' + name)
        if sha and meta['Labels']['org.opencontainers.image.revision'] != sha:
            raise ValueError('Runtime source mismatch: ' + name)
        if self.command(['systemctl', '--user', 'is-active', name + '.service']) != 'active':
            raise ValueError('Runtime service is inactive: ' + name)

    def reconcile(self, state):
        self.audit_installation()
        if state['phase'] == 'complete':
            self.verify_runtime(state)
            return
        if state['phase'] == 'preflight':
            if self.active_slot() != state['old']:
                raise ValueError('Installed active slot changed')
        else:
            if 'old_image' not in state:
                raise ValueError('Missing previous artifact identity')
            old = 'gp-api-' + state['old']
            if self.running(old):
                self.verify_image(old, state['old_image'])
            if state['phase'] not in ('candidate',):
                self.verify_image('gp-api-' + state['new'], state['image'], state['sha'])
            if state['phase'] not in ('candidate', 'switch'):
                if self.active_slot() != state['new']:
                    raise ValueError('Active slot differs from persisted switch')
                self.probe('public', state)
                self.probe('nas-public', state)
                self.probe('nas-protected', state)

    def proxy(self, *args):
        return json.loads(self.command(['sudo', '-n', '/usr/local/sbin/pcu-api-proxy', *args]))

    def nginx_fingerprint(self):
        status = self.proxy('status')
        return status['fingerprint'], status['effective']

    def audit_installation(self):
        fingerprint, effective = self.nginx_fingerprint()
        if fingerprint != self.config['nginx_config_sha256']:
            raise ValueError('Effective nginx configuration differs from adoption evidence')
        if re.search(r'worker_shutdown_timeout\s+(?!0(?:ms|s)?\s*;)', effective):
            raise ValueError('Nginx worker shutdown deadline would interrupt drain')
        if effective.count('upstream pcu_api_active {') != 1 or '/api/internal/file-access' not in effective:
            raise ValueError('Shared public and file authorization upstream is absent')
        without_upstream = re.sub(r'upstream pcu_api_active\s*\{[^}]*\}', '', effective)
        if re.search(r'(?:127\.0\.0\.1|localhost):400[01]', without_upstream):
            raise ValueError('A direct API address bypasses the shared active upstream')
        if effective.count('proxy_pass http://pcu_api_active') < 3 or '/api/webgl-play/reports/' not in effective:
            raise ValueError('Public API, internal TLS authorization and report routes must share one upstream')
        if self.running('gp-api'):
            raise ValueError('Legacy API is still running; first adoption requires maintenance')
        infra = self.command(['podman', 'pod', 'inspect', '--format', '{{.InfraContainerID}}', 'graduationproject'])
        ports = self.command(['podman', 'port', infra]).splitlines()
        for port in (4000, 4001):
            matches = [line for line in ports if line.startswith(f'{port}/tcp -> ')]
            if matches != [f'{port}/tcp -> 127.0.0.1:{port}']:
                raise ValueError('Live pod API ports are not the installed loopback slots')
        for slot in ('a', 'b'):
            name = f'gp-api-{slot}'
            source = self.command(['systemctl', '--user', 'show', name + '.service', '--property=SourcePath', '--value'])
            fragment = self.command(['systemctl', '--user', 'show', name + '.service', '--property=FragmentPath', '--value'])
            if source != str(self.quadlet / (name + '.container')) or '/generator' not in fragment:
                raise ValueError('API slot is not the adopted Quadlet-generated service')
        if self.command(['systemctl', '--user', 'is-enabled', 'pcu-slot-boot.service']) != 'enabled':
            raise ValueError('Slot boot restoration service is not enabled')
        if not self.nginx_workers():
            raise ValueError('Nginx has no observable live workers')

    def preflight(self, state):
        if self.config.get('version') != 2:
            raise ValueError('Reviewed installation manifest is required')
        if self.proxy('status')['slot'] != state['old']:
            raise ValueError('Proxy and recorded active slot differ')
        old = 'gp-api-' + state['old']
        state['old_image'] = self.inspect(old)['ImageName']
        self.verify_image(old, state['old_image'])
        state['old_workers'] = {name: self.inspect(name)['ImageName'] for name in WORKERS}
        for name, image in state['old_workers'].items():
            self.verify_image(name, image)
        if self.running('gp-api-' + state['new']):
            raise ValueError('Inactive slot is already occupied')
        for worker in WORKERS:
            status = self.control(worker, 'status')
            if status.get('kind') != 'worker' or status.get('paused') is not False:
                raise ValueError('Worker control is not ready')
        old_status = self.control(old, 'status')
        if old_status.get('maintenance', {}).get('paused') is not False:
            raise ValueError('Old API maintenance is not active')
        self.command(['bash', str(self.root / 'deploy.sh'), 'release-artifact-preflight', 'phase2'])
        self.command(['bash', str(self.root / 'deploy.sh'), 'rolling-schema-check'])
        evidence = json.loads((self.root / 'rolling-compatibility.json').read_text())
        if (evidence.get('source_sha'), evidence.get('image'), evidence.get('previous_image')) != (
                state['sha'], state['image'], state['old_image']):
            raise ValueError('Compatibility evidence does not match both artifacts')
        for key in ('old_web_new_api', 'old_new_api_data', 'old_new_worker_jobs'):
            if evidence.get(key) is not True:
                raise ValueError('Missing compatibility evidence: ' + key)
        memory = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
        required = evidence.get('additional_api_memory_mb', 0)
        connections = evidence.get('additional_api_connections', 0)
        if not isinstance(required, int) or required < 1 or int(memory['MemAvailable'].split()[0]) < required * 1024:
            raise ValueError('Insufficient measured memory headroom for candidate API')
        pid = self.inspect(old)['State']['Pid']
        status = dict(line.split(':', 1) for line in Path(f'/proc/{pid}/status').read_text().splitlines())
        if required * 1024 < int(status['VmRSS'].split()[0]):
            raise ValueError('Candidate memory allowance is smaller than the current API RSS')
        group = Path(f'/proc/{pid}/cgroup').read_text().strip().split('::')
        if len(group) != 2:
            raise ValueError('Unified cgroup memory accounting is required')
        # Walk parent limits too: a pod/user slice cap may be tighter than the host.
        cgroup_root = Path('/sys/fs/cgroup')
        current = cgroup_root / group[1].lstrip('/')
        for directory in [current, *current.parents]:
            if directory == cgroup_root.parent:
                break
            if (directory / 'memory.max').exists():
                limit = (directory / 'memory.max').read_text().strip()
                used = int((directory / 'memory.current').read_text())
                if limit != 'max' and int(limit) - used < required * 1024 * 1024:
                    raise ValueError('Insufficient API/pod/user cgroup memory headroom')
        if not isinstance(connections, int) or connections < 10:
            raise ValueError('Candidate connection budget must be positive')
        sql = "SELECT current_setting('max_connections')::int - current_setting('superuser_reserved_connections')::int - count(*) FROM pg_stat_activity"
        available = int(self.command(['podman', 'exec', 'gp-postgres', 'sh', '-c',
            'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$1"', 'sh', sql]))
        if available < connections:
            raise ValueError('Insufficient measured PostgreSQL connection headroom')
        # Verify every actual probe before changing service state.
        self.command(['node', str(self.root / 'rolling-smoke.mjs'), 'validate', str(self.root)])
        for mode in ('public', 'nas-public', 'nas-protected'):
            self.probe(mode, {**state, 'new': state['old']})

    def snapshot(self, sha):
        self.command(['bash', str(self.root / 'release-db-snapshot.sh'), sha])

    def definition(self, name, image):
        file = self.quadlet / (name + '.container')
        text = file.read_text()
        text, count = re.subn(r'^Image=' + IMAGE + '$', 'Image=' + image, text, flags=re.M)
        if count != 1:
            raise ValueError('Installed definition has no immutable image: ' + name)
        save(file, text)
        self.command(['systemctl', '--user', 'daemon-reload'])

    def ready_control(self, name):
        deadline = time.monotonic() + 90
        while True:
            try:
                status = self.control(name, 'status')
                if status.get('kind') == 'worker' or status.get('state') == 'ready':
                    return status
            except subprocess.CalledProcessError:
                pass
            if time.monotonic() >= deadline:
                raise ValueError('Runtime control did not become ready: ' + name)
            time.sleep(1)

    def start_candidate(self, state):
        name = 'gp-api-' + state['new']
        if not self.running(name):
            save(self.root / ('runtime-env/slot-' + state['new'] + '.env'), 'API_MAINTENANCE_PAUSED=true\n')
            self.definition(name, state['image'])
            self.command(['systemctl', '--user', 'start', name + '.service'])
        self.verify_image(name, state['image'], state['sha'])
        # Same DB, cookies, signing keys and storage endpoints must survive handoff.
        def env(container):
            return dict(value.split('=', 1) for value in self.inspect(container)['Config']['Env'])
        previous, candidate = env('gp-api-' + state['old']), env(name)
        keys = [key for key in previous.keys() | candidate.keys() if key.startswith(('SESSION_', 'COOKIE_', 'S3_', 'FILE_GATEWAY_'))]
        keys += ['DATABASE_URL', 'PUBLIC_ASSET_ORIGIN', 'API_PUBLIC_URL', 'WEB_PUBLIC_URL', 'TRUST_PROXY', 'GOOGLE_CLIENT_IDS', 'CORS_ALLOWED_ORIGINS']
        if any(previous.get(key) != candidate.get(key) for key in keys):
            raise ValueError('Candidate shared state or signing configuration differs')
        status = self.ready_control(name)
        if status.get('maintenance', {}).get('paused') is not True:
            raise ValueError('Candidate started maintenance before handoff')

    def nginx_workers(self):
        return self.proxy('status')['workers']

    def nginx_workers_gone(self, workers):
        for pid, started in workers:
            try:
                fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
                if fields[19] == started:
                    return False
            except FileNotFoundError:
                continue
        return True

    def switch(self, state):
        self.proxy('switch', state['new'])

    def probe(self, mode, state):
        self.command(['node', str(self.root / 'rolling-smoke.mjs'), mode, str(self.root), state['new']])

    def stop(self, name):
        # Caller must prove idle before entering the existing forced-exit budget.
        self.command(['systemctl', '--user', 'stop', name + '.service'])
        if self.running(name):
            raise ValueError('Service did not stop: ' + name)

    def pause_maintenance(self, slot):
        save(self.root / f'runtime-env/slot-{slot}.env', 'API_MAINTENANCE_PAUSED=true\n')

    def enable_maintenance(self, state):
        name = 'gp-api-' + state['new']
        self.verify_image(name, state['image'], state['sha'])
        save(self.root / ('runtime-env/slot-' + state['new'] + '.env'), 'API_MAINTENANCE_PAUSED=false\n')
        self.control(name, 'resume')
        status = self.control(name, 'status')
        if status.get('maintenance', {}).get('error'):
            raise ValueError('Maintenance activation failed')

    def maintenance_ready(self, state):
        status = self.control('gp-api-' + state['new'], 'status').get('maintenance', {})
        if status.get('error'):
            raise ValueError('Maintenance activation failed')
        return status.get('paused') is False and status.get('starting') is False

    def replace_worker(self, name, state):
        self.definition(name, state['image'])
        self.command(['systemctl', '--user', 'start', name + '.service'])
        self.verify_image(name, state['image'], state['sha'])
        status = self.ready_control(name)
        if status.get('paused') is not False:
            raise ValueError('Replacement worker is not accepting jobs')

    def verify_runtime(self, state):
        if self.active_slot() != state['new'] or self.proxy('status')['slot'] != state['new']:
            raise ValueError('Final active slot differs from the release')
        for name in WORKERS:
            status = self.control(name, 'status')
            if status.get('kind') != 'worker' or status.get('paused') is not False:
                raise ValueError('Final worker is not accepting jobs: ' + name)
        for name in ['gp-api-' + state['new'], *WORKERS]:
            self.verify_image(name, state['image'], state['sha'])
        status = self.control('gp-api-' + state['new'], 'status')
        if status.get('state') != 'ready' or status.get('maintenance', {}).get('paused') is not False or status.get('maintenance', {}).get('error') is not False:
            raise ValueError('Final API runtime is not ready')
        if not self.maintenance_ready(state):
            raise ValueError('Maintenance startup has not completed')
        self.probe('public', state)
        self.probe('nas-public', state)
        self.probe('nas-protected', state)


def boot_plan(state, active, upstream, definitions):
    """Select identities only from durable evidence; boot never advances a release."""
    if active not in ('a', 'b') or upstream not in ('a', 'b'):
        raise ValueError('Invalid slot')
    if not state or state['phase'] == 'complete':
        if active != upstream:
            raise ValueError('Proxy and recorded active slot differ')
        return {name: definitions[name] for name in ['gp-api-' + active, *WORKERS]}, active
    phase, old, new = state['phase'], state['old'], state['new']
    if phase not in ('preflight', 'candidate', 'switch', 'drain', 'handoff', 'workers', 'web-pending'):
        raise ValueError('Unknown release phase')
    expected = old if phase in ('preflight', 'candidate') else new
    if phase == 'switch':
        if active not in (old, new) or upstream not in (old, new):
            raise ValueError('Switch evidence mismatch')
    elif active != expected or upstream != expected:
        raise ValueError('Journal and upstream differ')
    if phase == 'preflight':
        return {name: definitions[name] for name in ['gp-api-' + old, *WORKERS]}, old
    result = {}
    if phase in ('candidate', 'switch', 'drain', 'handoff'):
        result['gp-api-' + old] = state['old_image']
    if state.get('candidate_selected'):
        result['gp-api-' + new] = state['image']
    elif phase != 'candidate':
        raise ValueError('Missing candidate identity')
    for name in WORKERS:
        result[name] = state['image'] if name in state['workers'] else state['old_workers'][name]
    # Before handoff both APIs restart paused. Explicit resume transfers maintenance.
    maintenance = new if phase in ('workers', 'web-pending') else None
    return result, maintenance


def boot(host):
    root = host.root
    host.audit_installation()
    if (root / 'cutover-state/mutation-drained').exists() or (root / 'cutover-state/maintenance-in-progress').exists():
        raise ValueError('Maintenance deployment requires explicit recovery')
    file = root / 'cutover-state/rolling-release.json'
    state = json.loads(file.read_text()) if file.exists() else None
    definitions = {}
    for name in ['gp-api-a', 'gp-api-b', *WORKERS]:
        matches = re.findall(r'^Image=(' + IMAGE + r')$', (host.quadlet / (name + '.container')).read_text(), re.M)
        if len(matches) != 1:
            raise ValueError('Invalid installed image: ' + name)
        definitions[name] = matches[0]
    upstream = host.proxy('status')['slot']
    plan, maintenance = boot_plan(state, host.active_slot(), upstream, definitions)
    # An unready inactive candidate must not prevent restoration of the serving
    # API and workers. Do not select another serving slot when readiness fails.
    order = ['gp-api-' + upstream, *WORKERS, 'gp-api-' + ('b' if upstream == 'a' else 'a')]
    plan = {name: plan[name] for name in order if name in plan}
    for name, image in plan.items():
        if not re.fullmatch(IMAGE, image):
            raise ValueError('Missing immutable boot identity')
        # Never replace a live process during boot recovery.
        if host.running(name):
            host.verify_image(name, image)
    for slot in ('a', 'b'):
        name = 'gp-api-' + slot
        if host.running(name) and name not in plan:
            raise ValueError('Unexpected live API slot')
        save(root / f'runtime-env/slot-{slot}.env', 'API_MAINTENANCE_PAUSED=' + ('false' if slot == maintenance else 'true') + '\n')
    for name, image in plan.items():
        if not host.running(name):
            host.definition(name, image)
            host.command(['systemctl', '--user', 'start', name + '.service'])
        host.verify_image(name, image)
        host.ready_control(name)
    print(json.dumps(dict(event='boot-restored', services=plan, maintenance=maintenance)))


def main():
    root = Path(os.environ.get('DEPLOY_DIR', '/srv/graduationproject_v2'))
    if sys.argv[1:] == ['fingerprint-nginx']:
        print(Host(root).nginx_fingerprint()[0])
        return
    if sys.argv[1:] == ['audit-installation']:
        Host(root).audit_installation()
        print('Live nginx, loopback pod ports and Quadlet slots verified')
        return
    state_dir = root / 'cutover-state'
    state_dir.mkdir(mode=0o700, exist_ok=True)
    # Also used by maintenance deployment/recovery entry points.
    with (state_dir / 'host-release.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        os.environ['RELEASE_HOST_LOCK_HELD'] = 'true'
        os.environ['RELEASE_ROLLING_ACTIVE'] = 'true'
        if sys.argv[1:] == ['boot']:
            boot(Host(root))
            return
        release = Release(Host(root), state_dir / 'rolling-release.json',
                          os.environ['RELEASE_SOURCE_SHA'], os.environ['FINAL_IMAGE'])
        state = release.run()
        if sys.argv[1:] == ['complete']:
            if state['phase'] not in ('web-pending', 'complete'):
                raise ValueError('Runtime handoff has not completed')
            def web_ready():
                try:
                    release.host.command(['bash', str(root / 'deploy.sh'), 'verify-final-web', release.sha])
                    return True
                except subprocess.CalledProcessError:
                    return False
            release.wait(web_ready)
            release.host.verify_runtime(state)
            release.persist(phase='complete')
        print(json.dumps(release.state))


if __name__ == '__main__':
    try:
        main()
    except Deferred as error:
        print(str(error), file=sys.stderr)
        sys.exit(75)
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
