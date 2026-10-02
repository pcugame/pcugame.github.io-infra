import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/release-api-cutover.yml', import.meta.url), 'utf8');
const block = workflow.slice(workflow.indexOf('      - id: release'), workflow.indexOf('\n  snapshot:'));
const script = block.slice(block.indexOf('        run: |\n') + '        run: |\n'.length).split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
const image = `ghcr.io/pcugame/pcu-graduationproject-v2-api@sha256:${'a'.repeat(64)}`;
function authorize(overrides = {}) {
  return spawnSync('bash', ['-c', script], { encoding: 'utf8', env: {
    PATH: process.env.PATH, GITHUB_OUTPUT: '/dev/null', EXPECTED_IMAGE_REPO: 'ghcr.io/pcugame/pcu-graduationproject-v2-api',
    RELEASE_PHASE: 'phase2', FINAL_IMAGE: image, PHASE1_IMAGE: '', PHASE1_SOURCE_SHA: '',
    FORWARD_FIX_ACKNOWLEDGEMENT: '', ...overrides,
  } });
}

for (const phase of ['phase1', 'phase2', 'preflight', 'unknown']) {
  test(`retired release phase ${phase} rejects before production actions`, () => {
    assert.notEqual(authorize({ RELEASE_PHASE: phase }).status, 0);
  });
}
test('removed exception and observation inputs have no dispatch or execution path', () => {
  for (const key of ['phase1_api_image', 'phase1_source_sha', 'observation_exception_id', 'exception_profile', 'observation_started_at', 'observation_attestation', 'I_ACCEPT_SHORT_OBSERVATION', 'I_ATTEST_24H_ZERO_FALLBACK', 'contract-preflight']) assert.ok(!workflow.includes(key), key);
});
test('release and snapshot reject manual images and forward-fix acknowledgement', () => {
  for (const phase of ['release', 'snapshot']) {
    assert.equal(authorize({ RELEASE_PHASE: phase, FINAL_IMAGE: '' }).status, 0);
    for (const override of [{ FINAL_IMAGE: image }, { FINAL_IMAGE: '', FORWARD_FIX_ACKNOWLEDGEMENT: 'unexpected' }]) assert.notEqual(authorize({ RELEASE_PHASE: phase, ...override }).status, 0);
  }
});
test('forward fix requires an authorized digest and explicit acknowledgement', () => {
  const base = { RELEASE_PHASE: 'phase2-forward-fix', FORWARD_FIX_ACKNOWLEDGEMENT: 'I_ACKNOWLEDGE_CONTRACT_FORWARD_FIX' };
  assert.equal(authorize(base).status, 0);
  for (const override of [{ FORWARD_FIX_ACKNOWLEDGEMENT: '' }, { FINAL_IMAGE: 'latest' }, { FINAL_IMAGE: image.replace('pcugame/', 'attacker/') }, { FINAL_IMAGE: image.toUpperCase() }]) assert.notEqual(authorize({ ...base, ...override }).status, 0);
});
test('ordinary release preserves snapshots, identity, Pages, drain and migration recovery boundary', () => {
  const prepare = workflow.slice(workflow.indexOf('      - name: Prepare release maintenance window'), workflow.indexOf('      - name: Verify external Pages repository'));
  const order = ['release-artifact-preflight phase2', 'release-assert phase2', 'release-db-snapshot.sh', 'release-recovery.mjs" capture', 'deploy.sh" drain', 'backup "release-'];
  let cursor = -1;
  for (const key of order) { const next = prepare.indexOf(key, cursor + 1); assert.ok(next > cursor, key); cursor = next; }
  assert.equal((workflow.match(/run: node server\/verify-github-release-boundaries.mjs pages\n/g) ?? []).length, 2);
  assert.ok(workflow.indexOf('Build final web') < workflow.indexOf('Prepare release maintenance window'));
  assert.ok(workflow.indexOf('verify-final-web') < workflow.indexOf('release-migrate apply-contract'));
  assert.ok(workflow.indexOf('mark-migration') < workflow.indexOf('release-migrate apply-contract'));
  assert.match(workflow, /steps\.apply-contract\.outcome == 'skipped'/);
  assert.match(workflow, /steps\.restore-pages\.outcome == 'success'/);
  assert.match(workflow, /actual_source.*RELEASE_SOURCE_SHA/);
  assert.match(workflow, /actual_digest.*FINAL_IMAGE/);
  assert.match(workflow, /full_commit_message: Deploy \$\{\{ github.sha \}\} \(run \$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}\)/);
});
test('historical alternate SQL and receipt migrations remain required artifacts', () => {
  const build = readFileSync(new URL('../.github/workflows/deploy-api.yml', import.meta.url), 'utf8');
  for (const marker of ['20260822000001_canonical_asset_contract_age_exception', '20260822000002_canonical_asset_contract_image_bridge36', '20260822000003_canonical_asset_contract_image_bridge_traffic', '20260821990000_release_exception_receipts', '20260821991000_release_image_bridge_exception', '20260821992000_release_image_bridge_traffic']) assert.ok(build.includes(marker), marker);
  for (const cli of ['backfill-canonical-assets', 'preflight-canonical-contract', 'verify-cutover-report', 'correct-canonical-assets', 'correct-canonical-poster']) assert.ok(!build.includes(cli), cli);
  for (const cli of ['release-migrate', 'snapshot-garage-inventory']) assert.ok(build.includes(cli), cli);
});
