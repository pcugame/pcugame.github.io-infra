import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { recoveryDecision, runRecovery } from './release-recovery.mjs';
import { pagesRestoreDecision, runPagesRecovery } from './pages-release-recovery.mjs';

const before = 'a'.repeat(40), current = 'b'.repeat(40), source = 'c'.repeat(40), runKey = '123-1';
test('Pages rollback refuses another writer and accepts only this release publication', () => {
 const fixture = { before, current, source, runKey, subject: `Deploy ${source} (run ${runKey})`, releaseSha: source };
 assert.equal(pagesRestoreDecision(fixture), 'restore');
 assert.equal(pagesRestoreDecision({ ...fixture, current: before }), 'unchanged');
 for (const change of [{ subject: 'someone else' }, { releaseSha: before }, { runKey: '124-1' }]) assert.throws(() => pagesRestoreDecision({ ...fixture, ...change }));
});
const imageName = `localhost/pcu-api@sha256:${'a'.repeat(64)}`;
function fixture(envName = 'common.env') {
 const deployDir = mkdtempSync(join(tmpdir(), 'pcu-recovery-test-'));
 const quadletDir = join(deployDir, 'quadlet');
 mkdirSync(join(deployDir, 'cutover-state')); mkdirSync(quadletDir);
 const envFile = join(deployDir, envName); writeFileSync(envFile, 'SECRET=fixture');
 const envDirective = JSON.stringify(envFile.replace(/%/g, '%%').replace(/\$/g, () => '$$'));
 const names = ['gp-api', 'gp-worker-image'];
 for (const name of ['gp-worker-game-validation.container', 'gp-worker-webgl.container', 'gp-worker-video.container', 'gp-worker-export.container', 'gp-worker-project-publication.container', 'gp-postgres.container', 'graduationproject.pod', 'gp-pg-data.volume']) writeFileSync(join(quadletDir, name), '# fixture');
 for (const name of names) writeFileSync(join(quadletDir, `${name}.container`), `Image=${imageName}\nEnvironmentFile=${envDirective}\n`);
 const containers = new Map(names.map(name => [name, { Name: name, Id: 'd'.repeat(64), Image: 'b'.repeat(64), ImageName: imageName, State: { Status: 'running' } }]));
 const calls = []; let definition = 'initial', healthy = true, failure = null, reload = 'no', effective = 'initial';
 const podman = args => {
  calls.push(['podman', ...args]);
  if (args[0] === 'inspect') { const c = containers.get(args[1]); if (!c) throw new Error('not found'); return JSON.stringify([c]); }
  if (args[0] === 'exec') return JSON.stringify({ ok: healthy });
  assert.fail(`Unexpected Podman lifecycle command ${args}`);
 };
 const systemctl = args => {
  calls.push(['systemctl', ...args]); const verb = args[1], unit = args[2];
  if (verb === 'cat') return `[Service]\nEnvironmentFile=${envDirective}\n# ${definition}`;
  if (verb === 'show') return args[3].includes('LoadState') ? `LoadState=loaded\nNeedDaemonReload=${reload}\nEnvironment=definition-${effective}` : `ActiveState=${containers.has(unit.replace(/\.service$/, '')) ? 'active' : 'inactive'}\nSubState=running`;
  if (verb === 'start') {
   if (failure === unit) throw new Error('systemctl fixture failure');
   const name = unit.replace(/\.service$/, '');
   containers.set(name, { Name: name, Id: 'e'.repeat(64), Image: 'b'.repeat(64), ImageName: imageName, State: { Status: 'running' } });
   return '';
  }
  assert.fail(`Unexpected systemctl ${args}`);
 };
 return { deployDir, quadletDir, envFile, containers, calls, options: { deployDir, quadletDir, podman, systemctl, webVerified: true, sleep: async () => {} },
  setDefinition: value => { definition = value; }, setReload: value => { reload = value; }, setEffective: value => { effective = value; }, setHealthy: value => { healthy = value; }, setFailure: value => { failure = value; },
  cleanup: () => rmSync(deployDir, { recursive: true, force: true }) };
}
test('SQL attempt, missing previous web, and absent API fail before runtime starts', () => {
 const state = { version: 2, quadletDir: '/fixture', definitionHash: 'hash', containers: [{ name: 'gp-api', image: 'd'.repeat(64), imageName }] };
 assert.equal(recoveryDecision(state, false, true), 'restart');
 assert.equal(recoveryDecision(null, false, false), 'nothing');
 assert.throws(() => recoveryDecision(state, true, true), /Migration was attempted/);
 assert.throws(() => recoveryDecision(null, true, true), /Migration was attempted/);
 assert.throws(() => recoveryDecision(state, false, false), /Pages/);
 assert.throws(() => recoveryDecision({ ...state, containers: [] }, false, true), /API/);
 assert.throws(() => recoveryDecision({ ...state, containers: [{ ...state.containers[0], imageName: 'latest' }] }, false, true), /Invalid captured/);
});

for (const failure of ['status', 'apply-contract']) test(`persisted boundary after migrate ${failure} failure`, async () => {
 const f = fixture();
 try {
  await runRecovery('capture', runKey, f.options);
  f.containers.clear(); f.calls.length = 0;
  const drained = join(f.deployDir, 'cutover-state', 'mutation-drained');
  writeFileSync(drained, 'yes');
  copyFileSync(new URL('./release-recovery.mjs', import.meta.url), join(f.deployDir, 'release-recovery.mjs'));
  writeFileSync(join(f.deployDir, 'deploy.sh'), `#!/usr/bin/env bash\nset -eu\n[[ "$1" == release-migrate ]]\n[[ "$2" != "$FAIL_ACTION" ]]\n`);
  const result = spawnSync('bash', [resolve('server/release-orchestrate.sh'), 'migrate'], {
   encoding: 'utf8', env: { ...process.env, DEPLOY_DIR: f.deployDir, RELEASE_RUN_KEY: runKey,
    RELEASE_SOURCE_SHA: source, FINAL_IMAGE: `ghcr.io/pcugame/pcu-graduationproject-v2-api@sha256:${'a'.repeat(64)}`, FAIL_ACTION: failure },
  });
  assert.notEqual(result.status, 0);
  const attempted = existsSync(join(f.deployDir, 'cutover-state', `recovery-${runKey}`, 'migration-attempted'));
  assert.equal(attempted, failure === 'apply-contract');
  if (attempted) {
   await assert.rejects(runRecovery('assert-pre-migration', runKey, f.options), /Migration was attempted/);
   await assert.rejects(runRecovery('recover', runKey, f.options), /Migration was attempted/);
   assert.equal(f.calls.length, 0);
   assert.ok(existsSync(drained));
  } else {
   await runRecovery('assert-pre-migration', runKey, f.options);
   assert.equal(f.calls.length, 0, 'eligibility is read-only');
   await assert.rejects(runRecovery('recover', runKey, { ...f.options, webVerified: false }), /Pages/);
   await runRecovery('recover', runKey, f.options);
   assert.ok(f.containers.has('gp-api'));
   assert.equal(existsSync(drained), false);
  }
 } finally { f.cleanup(); }
});

test('pre-migration gate fails closed on missing capture and any persisted marker entry', async () => {
 const f = fixture();
 try {
  await assert.rejects(runRecovery('assert-pre-migration', runKey, f.options), /ENOENT/);
  await runRecovery('capture', runKey, f.options);
  await runRecovery('assert-pre-migration', runKey, f.options);
  const marker = join(f.deployDir, 'cutover-state', `recovery-${runKey}`, 'migration-attempted');
  symlinkSync(join(f.deployDir, 'missing-target'), marker);
  f.calls.length = 0;
  await assert.rejects(runRecovery('assert-pre-migration', runKey, f.options), /Migration was attempted/);
  await assert.rejects(runRecovery('recover', runKey, f.options), /Migration was attempted/);
  assert.equal(f.calls.length, 0);
 } finally { f.cleanup(); }
});
test('recovery recreates removed containers through systemd, API health precedes captured workers', async () => {
 const f = fixture();
 try {
  await runRecovery('capture', runKey, f.options);
  f.containers.clear(); f.calls.length = 0;
  writeFileSync(join(f.deployDir, 'cutover-state', 'mutation-drained'), 'yes');
  await runRecovery('recover', runKey, f.options);
  assert.deepEqual(f.calls.filter(c => c[1] === '--user' && c[2] === 'start').map(c => c[3]), ['gp-api.service', 'gp-worker-image.service']);
  const health = f.calls.findIndex(c => c[0] === 'podman' && c[1] === 'exec');
  assert.ok(health > f.calls.findIndex(c => c[2] === 'start' && c[3] === 'gp-api.service'));
  assert.ok(health < f.calls.findIndex(c => c[2] === 'start' && c[3] === 'gp-worker-image.service'));
  assert.equal(f.containers.get('gp-api').Id, 'e'.repeat(64));
  assert.ok(!existsSync(join(f.deployDir, 'cutover-state', 'mutation-drained')));
  const saved = readFileSync(join(f.deployDir, 'cutover-state', `recovery-${runKey}`, 'runtime.json'), 'utf8');
  assert.ok(!saved.includes('SECRET') && !saved.includes('"id"'));
  await runRecovery('mark-migration', runKey, f.options);
  const count = f.calls.length;
  await assert.rejects(runRecovery('recover', runKey, f.options), /Migration was attempted/);
  assert.equal(f.calls.length, count);
 } finally { f.cleanup(); }
});
for (const drift of ['digest', 'definition', 'effective', 'source', 'environment']) test(`recovery refuses changed ${drift} before starting any service`, async () => {
 const f = fixture();
 try {
  await runRecovery('capture', runKey, f.options);
  if (drift === 'digest') f.containers.get('gp-worker-image').Image = 'c'.repeat(64);
  if (drift === 'definition') f.setDefinition('changed-dropin');
  if (drift === 'effective') f.setEffective('changed-manager-property');
  if (drift === 'source') writeFileSync(join(f.quadletDir, 'gp-api.container'), `Image=${imageName}\nExec=changed\n`);
  if (drift === 'environment') writeFileSync(f.envFile, 'SECRET=changed');
  f.calls.length = 0;
  await assert.rejects(runRecovery('recover', runKey, f.options), /changed since capture/);
  assert.ok(!f.calls.some(c => c[2] === 'start'));
 } finally { f.cleanup(); }
});
test('renderer escaped env paths are captured and stale manager definitions fail before starts', async () => {
 const f = fixture('common % $ " spaced.env');
 try {
  await runRecovery('capture', runKey, f.options);
  f.containers.clear(); f.calls.length = 0; f.setReload('yes');
  await assert.rejects(runRecovery('recover', runKey, f.options), /requires daemon reload/);
  assert.ok(!f.calls.some(c => c[2] === 'start'));
  f.setReload('no'); await runRecovery('recover', runKey, f.options);
 } finally { f.cleanup(); }
});
for (const failure of ['gp-api.service', 'gp-worker-image.service', 'health']) test(`recovery fails closed on ${failure} failure`, async () => {
 const f = fixture();
 try {
  await runRecovery('capture', runKey, f.options); f.containers.clear(); f.calls.length = 0;
  writeFileSync(join(f.deployDir, 'cutover-state', 'mutation-drained'), 'yes');
  if (failure === 'health') f.setHealthy(false); else f.setFailure(failure);
  await assert.rejects(runRecovery('recover', runKey, f.options), /failure|health failed/);
  if (failure !== 'gp-worker-image.service') assert.ok(!f.calls.some(c => c[2] === 'start' && c[3] === 'gp-worker-image.service'));
  assert.ok(existsSync(join(f.deployDir, 'cutover-state', 'mutation-drained')));
  assert.ok(!existsSync(join(f.deployDir, 'cutover-state', `recovery-${runKey}`, 'recovered')));
 } finally { f.cleanup(); }
});
test('Pages restore uses force-with-lease and waits for the previous served SHA', async () => {
 const directory = mkdtempSync(join(tmpdir(), 'pcu-pages-recovery-test-'));
 const calls = []; let fetched = current;
 writeFileSync(join(directory, 'recovery.json'), JSON.stringify({ before, source, runKey, previousSource: before }));
 const exec = (_, args) => {
  calls.push(args);
  if (args[0] === 'rev-parse') return fetched;
  if (args[0] === 'show') return args.includes('--format=%s') ? `Deploy ${source} (run ${runKey})` : source;
  if (args[0] === 'push') { assert.ok(args.includes(`--force-with-lease=refs/heads/master:${current}`)); fetched = before; }
  if (args[0] === 'ls-remote') return `${fetched}\trefs/heads/master`;
  return '';
 };
 let reads = 0;
 try {
  await runPagesRecovery('restore', directory, source, runKey, { token: 'fixture', exec, fetchImpl: async () => ({ ok: true, text: async () => ++reads === 1 ? source : before }), sleep: async () => {} });
  assert.equal(reads, 2);
  assert.ok(calls.some(c => c[0] === 'push'));
  assert.equal(JSON.parse(readFileSync(join(directory, 'recovery.json'))).before, before);
 } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('recovery discovers an adopted custom Quadlet directory without sourcing shell configuration', async () => {
 const f = fixture();
 const systemctl = args => {
  if (args[3] === '--property=SourcePath') return join(f.quadletDir, 'gp-api.container');
  if (args[3] === '--property=FragmentPath') return '/run/user/999/systemd/generator/gp-api.service';
  return f.options.systemctl(args);
 };
 const options = { ...f.options, quadletDir: '', systemctl };
 try {
  await runRecovery('capture', runKey, options);
  f.containers.clear();
  await runRecovery('recover', runKey, options);
  assert.ok(f.containers.has('gp-api'));
 } finally { f.cleanup(); }
});
