import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
const root = new URL('../', import.meta.url);
test('retired transition controls cannot be invoked through production workflow', () => {
  assert.equal(existsSync(new URL('server/release-online-preflight.sh', root)), false);
  const workflow = readFileSync(new URL('.github/workflows/release-api-cutover.yml', root), 'utf8');
  assert.ok(!workflow.includes('release-online-preflight'));
  assert.ok(!workflow.includes('phase1-observation'));
  assert.ok(!workflow.includes('online-contract-preflight'));
  assert.match(workflow, /options: \[release, snapshot, phase2-forward-fix\]/);
});
