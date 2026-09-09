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

test('Phase 1 CD rejects branch artifacts and requires the exact dispatched master source', async () => {
  const { readFileSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const workflow = readFileSync(new URL('../.github/workflows/release-phase1-video-update.yml', import.meta.url), 'utf8');
  const body = workflow.split('        run: |\n')[1].split('\n      - uses:')[0].split('\n').map(line => line.replace(/^          /, '')).join('\n');
  const masterSha = 'a'.repeat(40);
  const fixture = {
    ...process.env, GITHUB_REPOSITORY: 'pcugame/pcugame.github.io-infra',
    GITHUB_DEFAULT_BRANCH: 'master', GITHUB_REF: 'refs/heads/master', GITHUB_SHA: masterSha,
    PHASE1_SOURCE_SHA: masterSha, PHASE1_IMAGE: `ghcr.io/pcugame/pcu-graduationproject-v2-api@sha256:${'b'.repeat(64)}`,
    PUBLISH_WEB: 'true',
  };
  assert.equal(spawnSync('bash', ['-euc', body], { env: fixture }).status, 0);
  for (const mismatch of [{ PHASE1_SOURCE_SHA: 'c'.repeat(40) }, { GITHUB_REF: 'refs/heads/worker/task' }]) {
    assert.notEqual(spawnSync('bash', ['-euc', body], { env: { ...fixture, ...mismatch } }).status, 0);
  }
  assert.match(workflow, /test -f apps\/api\/prisma\/migrations\/20260822000000_canonical_asset_contract\/migration.sql/);
  assert.doesNotMatch(workflow, /stage-phase1-image/);
});
