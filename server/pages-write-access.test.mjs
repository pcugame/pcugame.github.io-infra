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

test('routine release verifies the published web before migration and runtime changes', async () => {
  const { readFileSync } = await import('node:fs');
  const workflow = readFileSync(new URL('../.github/workflows/release-api-cutover.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(workflow, /PAGES_DEPLOY_ACTOR|single-writer/);
  assert.equal((workflow.match(/verify-github-release-boundaries\.mjs pages\s*$/gm) ?? []).length, 2);
  const publish = workflow.indexOf('- name: Publish exact final web while mutations remain drained');
  const verify = workflow.indexOf('- name: Verify final web before migrations');
  const update = workflow.indexOf('- name: Apply migrations and start verified release');
  assert.ok(publish > 0 && verify > publish && update > verify);
  assert.match(workflow.slice(verify, update), /exit 1/);
  assert.match(workflow.slice(verify, update), /verify-final-web "\$\{RELEASE_SOURCE_SHA\}"/);
});

test('production publishers reject non-master refs and foreign control repositories', async () => {
  const { readFileSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const masterSha = 'a'.repeat(40);
  const fixture = {
    ...process.env, GITHUB_REPOSITORY: 'pcugame/pcugame.github.io-infra',
    GITHUB_DEFAULT_BRANCH: 'master', GITHUB_REF: 'refs/heads/master', GITHUB_SHA: masterSha,
  };
  for (const path of ['release-api-cutover.yml', 'deploy-web-pages.yml']) {
    const workflow = readFileSync(new URL(`../.github/workflows/${path}`, import.meta.url), 'utf8');
    const body = workflow.split('        run: |\n')[1].split('\n      - uses:')[0].split('\n').map(line => line.replace(/^          /, '')).join('\n');
    assert.equal(spawnSync('bash', ['-euc', body], { env: fixture }).status, 0, path);
    for (const mismatch of [{ GITHUB_REF: 'refs/heads/worker/task' }, { GITHUB_DEFAULT_BRANCH: 'main' }, { GITHUB_REPOSITORY: 'someone/fork' }]) {
      assert.notEqual(spawnSync('bash', ['-euc', body], { env: { ...fixture, ...mismatch } }).status, 0, path);
    }
    assert.match(workflow, /printf '%s\\n' "\$\{GITHUB_SHA\}" > (?:apps\/web\/)?dist\/release-sha\.txt/);
  }
});
