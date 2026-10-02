import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/release-api-cutover.yml', import.meta.url), 'utf8');
const image = `ghcr.io/pcugame/pcu-graduationproject-v2-api@sha256:${'a'.repeat(64)}`;
function authorize(overrides = {}) {
  return spawnSync('bash', ['server/release-inputs.sh'], { encoding: 'utf8', env: {
    PATH: process.env.PATH, GITHUB_OUTPUT: '/dev/null', EXPECTED_IMAGE_REPO: 'ghcr.io/pcugame/pcu-graduationproject-v2-api',
    RELEASE_OPERATION: 'phase2', FINAL_IMAGE: image, PHASE1_IMAGE: '', PHASE1_SOURCE_SHA: '',
    FORWARD_FIX_ACKNOWLEDGEMENT: '', ...overrides,
  } });
}

for (const phase of ['phase1', 'phase2', 'preflight', 'unknown']) {
  test(`retired release phase ${phase} rejects before production actions`, () => {
    assert.notEqual(authorize({ RELEASE_OPERATION: phase }).status, 0);
  });
}
test('removed exception and observation inputs have no dispatch or execution path', () => {
  for (const key of ['phase1_api_image', 'phase1_source_sha', 'observation_exception_id', 'exception_profile', 'observation_started_at', 'observation_attestation', 'I_ACCEPT_SHORT_OBSERVATION', 'I_ATTEST_24H_ZERO_FALLBACK', 'contract-preflight']) assert.ok(!workflow.includes(key), key);
});
test('release and snapshot reject manual images and forward-fix acknowledgement', () => {
  for (const phase of ['release', 'snapshot']) {
    assert.equal(authorize({ RELEASE_OPERATION: phase, FINAL_IMAGE: '' }).status, 0);
    for (const override of [{ FINAL_IMAGE: image }, { FINAL_IMAGE: '', FORWARD_FIX_ACKNOWLEDGEMENT: 'unexpected' }]) assert.notEqual(authorize({ RELEASE_OPERATION: phase, ...override }).status, 0);
  }
});
test('forward fix requires an authorized digest and explicit acknowledgement', () => {
  const base = { RELEASE_OPERATION: 'forward-fix', FORWARD_FIX_ACKNOWLEDGEMENT: 'I_ACKNOWLEDGE_CONTRACT_FORWARD_FIX' };
  assert.equal(authorize(base).status, 0);
  for (const override of [{ FORWARD_FIX_ACKNOWLEDGEMENT: '' }, { FINAL_IMAGE: 'latest' }, { FINAL_IMAGE: image.replace('pcugame/', 'attacker/') }, { FINAL_IMAGE: image.toUpperCase() }]) assert.notEqual(authorize({ ...base, ...override }).status, 0);
});
test('build verifies checkout migration inventory and production entries before publishing', () => {
  const build = readFileSync(new URL('../.github/workflows/deploy-api.yml', import.meta.url), 'utf8');
  const verifier = readFileSync(new URL('../apps/api/scripts/verify-release-artifact.mjs', import.meta.url), 'utf8');
  assert.ok(build.includes('run: node apps/api/scripts/verify-release-artifact.mjs'));
  assert.ok(build.indexOf('run: node apps/api/scripts/verify-release-artifact.mjs') < build.indexOf('Publish verified release manifest'));
  assert.ok(!/202\d{11}_/.test(build), 'workflow must not pin historical migrations');
  for (const path of ['prisma/migrations', 'prisma/contract-migration-paths', 'dist/server.js']) assert.ok(verifier.includes(path), path);
  for (const cli of ['backfill-canonical-assets', 'preflight-canonical-contract', 'verify-cutover-report', 'correct-canonical-assets', 'correct-canonical-poster']) assert.ok(!verifier.includes(cli), cli);
  for (const cli of ['release-migrate', 'snapshot-garage-inventory']) assert.ok(verifier.includes(cli), cli);
});
