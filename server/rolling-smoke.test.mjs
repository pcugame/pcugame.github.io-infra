import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function config() {
  const read = { path: '/api/me', method: 'GET', status: 200, category: 'authenticated-read', json: { 'data.authenticated': true } };
  const write = { path: '/api/projects/test-only', method: 'PATCH', status: 200, category: 'authenticated-write', replaySafe: true, body: { title: 'probe' }, json: { 'data.title': 'probe' } };
  const collection = category => ({ ...read, category });
  const requests = [read, write, collection('empty-collection'), collection('populated-collection')];
  return { cookie: 'fixture', fixtures: [{ id: 'test-only', path: write.path, dedicated: true }],
    candidate: [...requests, { ...read, path: '/api/health/deep' }, { ...read, path: '/api/internal/file-access' }],
    public: requests, 'nas-public': [read], 'nas-protected': [read],
    cleanup: [{ ...write, body: { title: 'baseline' }, json: { 'data.title': 'baseline' } }] };
}
test('write probes require exact dedicated fixture and replayable cleanup before any network request', () => {
  const root = mkdtempSync(join(tmpdir(), 'rolling-smoke-'));
  try {
    const run = value => {
      writeFileSync(join(root, 'rolling-probes.json'), JSON.stringify(value), { mode: 0o600 });
      return spawnSync(process.execPath, [resolve('server/rolling-smoke.mjs'), 'validate', root], { encoding: 'utf8' });
    };
    assert.equal(run(config()).status, 0);
    for (const mutate of [
      c => { c.fixtures = []; },
      c => { c.fixtures[0].path += '/other'; },
      c => { c.cleanup = []; },
      c => { c.cleanup[0].method = 'GET'; },
      c => { c.candidate[1].replaySafe = false; },
      c => { c.candidate[1].method = 'POST'; },
    ]) {
      const value = config(); mutate(value);
      assert.notEqual(run(value).status, 0);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
