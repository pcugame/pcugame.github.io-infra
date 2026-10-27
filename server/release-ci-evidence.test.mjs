import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { recordEvidence, resolveCiEvidence } from './release-ci-evidence.mjs';

const repository = 'pcugame/pcugame.github.io-infra';
const source = 'a'.repeat(40), tested = 'b'.repeat(40), tree = 'c'.repeat(40);
const run = { id: 12, run_attempt: 2, path: '.github/workflows/pr-checks.yml', status: 'completed', conclusion: 'success', event: 'pull_request', head_repository: { full_name: repository } };
const receipt = { version: 1, repository, runId: 12, attempt: 2, source: tested, tree, api: true, web: true };
function fixture({ runOverride = {}, receiptOverride = {}, expired = false, testedTree = tree, missing = false } = {}) {
  return async url => {
    if (url.endsWith(`/git/commits/${source}`)) return { tree: { sha: tree } };
    if (url.endsWith(`/git/commits/${tested}`)) return { tree: { sha: testedTree } };
    if (url.endsWith('/zip')) return JSON.stringify({ ...receipt, ...receiptOverride });
    if (url.includes('/artifacts?')) return { artifacts: missing ? [] : [{ id: 42, name: 'ci-evidence-12-2', expired }] };
    if (url.includes('/workflows/')) return { workflow_runs: [{ ...run, ...runOverride }] };
    throw new Error(`Unexpected API request: ${url}`);
  };
}
const resolve = options => resolveCiEvidence(source, fixture(options), async value => value);

test('reuses successful PR merge checks across squash commit SHAs with the same tree', async () => {
  assert.deepEqual(await resolve(), { api: true, web: true, runs: [12] });
});
test('never reuses pending, failed, foreign repository or other workflow runs', async () => {
  for (const runOverride of [{ status: 'in_progress' }, { conclusion: 'failure' }, { event: 'push' },
    { head_repository: { full_name: 'someone/fork' } }, { path: '.github/workflows/other.yml' }]) {
    assert.deepEqual(await resolve({ runOverride }), { api: false, web: false, runs: [] });
  }
});
test('rejects mismatched source trees, stale attempts and expired or missing receipts', async () => {
  for (const options of [{ expired: true }, { missing: true }, { testedTree: 'd'.repeat(40) },
    ...[{ tree: 'd'.repeat(40) }, { attempt: 1 }, { runId: 11 }, { repository: 'someone/fork' },
      { source: 'invalid' }, { api: 'true' }, { version: 2 }].map(receiptOverride => ({ receiptOverride }))]) {
    assert.deepEqual(await resolve(options), { api: false, web: false, runs: [] });
  }
});
test('API-only CI does not suppress Web checks', async () => {
  assert.deepEqual(await resolve({ receiptOverride: { web: false } }), { api: true, web: false, runs: [12] });
});
test('reuses successful verify evidence when only integration was rerun', async () => {
  assert.deepEqual(await resolve({ runOverride: { run_attempt: 3 } }), { api: true, web: true, runs: [12] });
  assert.deepEqual(await resolve({ runOverride: { run_attempt: 1 } }), { api: false, web: false, runs: [] });
});
test('records actual checkout tree and explicitly selected checks', () => {
  assert.deepEqual(recordEvidence({ GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: '12', GITHUB_RUN_ATTEMPT: '2', CI_API: 'true', CI_WEB: 'false' }, ref => ref === 'HEAD' ? tested : tree), { ...receipt, web: false });
});
test('workflow reuse gates only duplicate verification and keeps artifact and runtime checks', () => {
  const build = readFileSync(new URL('../.github/workflows/deploy-api.yml', import.meta.url), 'utf8');
  const release = readFileSync(new URL('../.github/workflows/release-api-cutover.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const pr = readFileSync(new URL('../.github/workflows/pr-checks.yml', import.meta.url), 'utf8');
  assert.match(build, /name: Verify API build\s+if: steps\.ci\.outputs\.api != 'true'/);
  assert.match(build, /Verify immutable release artifact from the merged source/);
  for (const step of ['Test final web', 'Lint final web']) {
    assert.ok(release.includes(`name: ${step}\n        if: \${{ inputs.operation == 'release' && steps.ci.outputs.web != 'true' }}`));
  }
  assert.match(release, /name: Build final web\s+if: \$\{\{ inputs\.operation == 'release' \}\}/);
  assert.match(release, /Verify complete runtime health/);
  assert.match(pr, /name: ci-evidence-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}/);
  assert.ok(pr.indexOf('Record verified source') > pr.indexOf('name: Build Web'));
});
