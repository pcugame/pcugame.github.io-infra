import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertPagesWriteAccess } from './verify-github-release-boundaries.mjs';

const target = { full_name: 'pcugame/pcugame.github.io', default_branch: 'master', archived: false, permissions: { push: true, admin: false } };
test('Pages deployment permits collaborating writers without administrator or single-writer configuration', () => {
  assert.doesNotThrow(() => assertPagesWriteAccess(target));
});
test('Pages deployment rejects a wrong target or missing write access', () => {
  for (const repository of [undefined, { ...target, full_name: 'someone/other' }, { ...target, default_branch: 'other' }, { ...target, archived: true }, { ...target, permissions: {} }, { ...target, permissions: { push: false } }]) {
    assert.throws(() => assertPagesWriteAccess(repository));
  }
});

test('Phase 1 verifies the published compatible web before changing the API', async () => {
  const { readFileSync } = await import('node:fs');
  const workflow = readFileSync(new URL('../.github/workflows/release-phase1-video-update.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(workflow, /PAGES_DEPLOY_ACTOR|single-writer/);
  assert.equal((workflow.match(/mjs pages-write/g) ?? []).length, 2);
  const publish = workflow.indexOf('- name: Publish compatible Phase 1 web');
  const verify = workflow.indexOf('- name: Verify Pages serves the exact Phase 1 release');
  const update = workflow.indexOf('- name: Back up and apply only the additive Phase 1 update');
  assert.ok(publish > 0 && verify > publish && update > verify);
  assert.match(workflow.slice(verify, update), /exit 1/);
});
