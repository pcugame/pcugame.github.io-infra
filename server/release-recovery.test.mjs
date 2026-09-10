import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoveryDecision, runRecovery } from './release-recovery.mjs';
import { pagesRestoreDecision, runPagesRecovery } from './pages-release-recovery.mjs';

const before = 'a'.repeat(40), current = 'b'.repeat(40), source = 'c'.repeat(40), runKey = '123-1';
test('Pages rollback refuses another writer and accepts only this release publication', () => {
 const fixture = { before, current, source, runKey, subject: `Deploy ${source} (run ${runKey})`, releaseSha: source };
 assert.equal(pagesRestoreDecision(fixture), 'restore');
 assert.equal(pagesRestoreDecision({ ...fixture, current: before }), 'unchanged');
 for (const change of [{ subject: 'someone else' }, { releaseSha: before }, { runKey: '124-1' }]) assert.throws(() => pagesRestoreDecision({ ...fixture, ...change }));
});
test('SQL attempt, missing previous web, and absent API fail before runtime starts', () => {
 const state = { containers: [{ name: 'gp-api', id: 'd'.repeat(64) }] };
 assert.equal(recoveryDecision(state, false, true), 'restart');
 assert.equal(recoveryDecision(null, false, false), 'nothing');
 assert.throws(() => recoveryDecision(state, true, true), /Migration was attempted/);
 assert.throws(() => recoveryDecision(state, false, false), /Pages/);
 assert.throws(() => recoveryDecision({ containers: [] }, false, true), /API/);
});
test('pre-migration failure restarts captured containers without replacing them', async () => {
 const deployDir = mkdtempSync(join(tmpdir(), 'pcu-recovery-test-'));
 mkdirSync(join(deployDir, 'cutover-state'));
 const api = { Id: 'd'.repeat(64), Image: 'old-image', State: { Status: 'running' } };
 const calls = [];
 const podman = args => {
  calls.push(args);
  if (args[0] === 'inspect') { if (args[1] === 'gp-api' || args[1] === api.Id) return JSON.stringify([api]); throw new Error('not found'); }
  if (args[0] === 'start') { assert.equal(args[1], api.Id); api.State.Status = 'running'; return ''; }
  if (args[0] === 'exec') return '{"ok":true}';
  assert.fail(`Unexpected podman ${args}`);
 };
 try {
  await runRecovery('capture', runKey, { deployDir, podman });
  api.State.Status = 'exited'; writeFileSync(join(deployDir, 'cutover-state', 'mutation-drained'), 'yes');
  await runRecovery('recover', runKey, { deployDir, podman, webVerified: true });
  assert.ok(calls.some(c => c[0] === 'start'));
  assert.ok(!existsSync(join(deployDir, 'cutover-state', 'mutation-drained')));
  await runRecovery('mark-migration', runKey, { deployDir, podman });
  const count = calls.length;
  await assert.rejects(runRecovery('recover', runKey, { deployDir, podman, webVerified: true }), /Migration was attempted/);
  assert.equal(calls.length, count);
 } finally { rmSync(deployDir, { recursive: true, force: true }); }
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
