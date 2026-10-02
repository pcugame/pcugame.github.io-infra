import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
const root = new URL('../', import.meta.url);
test('retired transition controls cannot be invoked through production workflow', () => {
  assert.equal(existsSync(new URL('server/release-phase1-video-update.sh', root)), false);
  assert.equal(existsSync(new URL('.github/workflows/release-phase1-video-update.yml', root)), false);
  const workflow = readFileSync(new URL('.github/workflows/release-api-cutover.yml', root), 'utf8');
  assert.ok(!workflow.includes('release-phase1-video-update'));
  assert.ok(!workflow.includes('phase1_api_image'));
  assert.ok(!workflow.includes('apply-expand'));
  assert.match(workflow, /options: \[release, snapshot, phase2-forward-fix\]/);
});
