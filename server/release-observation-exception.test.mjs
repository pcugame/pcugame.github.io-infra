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
    OBSERVATION_STARTED_AT: '', OBSERVATION_ATTESTATION: '', OBSERVATION_EXCEPTION_ID: '', ...overrides,
  } });
}
const exception = { OBSERVATION_EXCEPTION_ID: 'reviewed-20260910', OBSERVATION_ATTESTATION: 'I_ACCEPT_SHORT_OBSERVATION', PHASE1_IMAGE: image, PHASE1_SOURCE_SHA: 'b'.repeat(40) };

test('normal path still requires truthful attestation and elapsed 24 hours', () => {
  assert.notEqual(authorize().status, 0);
  assert.notEqual(authorize({ OBSERVATION_ATTESTATION: 'I_ATTEST_24H_ZERO_FALLBACK', OBSERVATION_STARTED_AT: new Date().toISOString() }).status, 0);
  assert.equal(authorize({ OBSERVATION_ATTESTATION: 'I_ATTEST_24H_ZERO_FALLBACK', OBSERVATION_STARTED_AT: new Date(Date.now() - 25 * 3600000).toISOString() }).status, 0);
});

test('age exception requires explicit ID, acceptance, immutable images and current Phase 1 source', () => {
  const valid = authorize(exception);
  assert.equal(valid.status, 0, valid.stderr);
  for (const invalid of [
    { OBSERVATION_EXCEPTION_ID: '' }, { OBSERVATION_EXCEPTION_ID: '../bad' },
    { OBSERVATION_ATTESTATION: 'I_ATTEST_24H_ZERO_FALLBACK' }, { PHASE1_IMAGE: 'latest' },
    { PHASE1_SOURCE_SHA: '' }, { FINAL_IMAGE: 'latest' }, { OBSERVATION_STARTED_AT: new Date().toISOString() },
    { RELEASE_PHASE: 'phase1' }, { RELEASE_PHASE: 'phase2-forward-fix' }, { RELEASE_PHASE: 'snapshot' }, { RELEASE_PHASE: 'preflight' },
  ]) assert.notEqual(authorize({ ...exception, ...invalid }).status, 0, JSON.stringify(invalid));
});

test('preflight stage accepts no deployment inputs', () => {
  assert.equal(authorize({ RELEASE_PHASE: 'preflight', FINAL_IMAGE: '' }).status, 0);
  assert.notEqual(authorize({ RELEASE_PHASE: 'preflight' }).status, 0);
});

test('exception retains snapshot, identity, Pages and drained contract checks', () => {
  const prepare = workflow.slice(workflow.indexOf('      - name: Prepare atomic Phase 2 maintenance window'), workflow.indexOf('      - name: Set up Node for final web'));
  assert.match(prepare, /current_image#sha256:/);
  assert.match(prepare, /PHASE1_IMAGE##@|PHASE1_IMAGE##\*@/);
  assert.match(prepare, /org.opencontainers.image.revision/);
  assert.ok(prepare.indexOf('release-db-snapshot.sh') < prepare.indexOf('deploy.sh" drain'));
  assert.match(prepare, /verify-observation-window/);
  assert.equal((workflow.match(/run: node server\/verify-github-release-boundaries.mjs pages\n/g) ?? []).length, 2);
  const final = workflow.slice(workflow.indexOf('      - name: Verify final web and commit Phase 2 contract'));
  assert.ok(final.indexOf('verify-final-web') < final.indexOf('contract-preflight'));
  assert.ok(final.indexOf('contract-preflight') < final.indexOf('release-migrate apply-contract'));
  assert.match(final, /--exception-actor "\$\{EXCEPTION_ACTOR\}" --exception-run-id "\$\{EXCEPTION_RUN_ID\}"/);
});
