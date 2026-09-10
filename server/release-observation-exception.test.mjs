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
  const prepare = workflow.slice(workflow.indexOf('      - name: Prepare atomic Phase 2 maintenance window'), workflow.indexOf('      - name: Verify external Pages repository'));
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

test('regular release accepts no manual image or observation inputs', () => {
  assert.equal(authorize({ RELEASE_PHASE: 'release', FINAL_IMAGE: '' }).status, 0);
  assert.notEqual(authorize({ RELEASE_PHASE: 'release' }).status, 0);
  assert.notEqual(authorize({ RELEASE_PHASE: 'release', FINAL_IMAGE: '', EXCEPTION_PROFILE: 'image-bridge-36' }).status, 0);
});
test('image bridge profile requires the explicit phase2 exception authorization', () => {
  assert.equal(authorize({ ...exception, EXCEPTION_PROFILE: 'image-bridge-36' }).status, 0);
  assert.notEqual(authorize({ ...exception, EXCEPTION_PROFILE: 'unknown' }).status, 0);
  assert.notEqual(authorize({ ...exception, EXCEPTION_PROFILE: 'image-bridge-36', OBSERVATION_EXCEPTION_ID: '' }).status, 0);
});
test('web build and online checks precede drain; frozen checks precede publication', () => {
  const prepare = workflow.indexOf('      - name: Prepare atomic Phase 2 maintenance window');
  assert.ok(workflow.indexOf('      - name: Build final web') < prepare);
  const block = workflow.slice(prepare, workflow.indexOf('      - name: Verify external Pages repository'));
  assert.ok(block.indexOf('release-assert phase2') < block.indexOf('deploy.sh" drain'));
  assert.ok(block.indexOf('online-contract-preflight') < block.lastIndexOf('deploy.sh" drain'));
  assert.match(block, /phase2-contract-prepublish.json/);
  assert.match(workflow, /needs.build_image.outputs.image/);
  assert.match(workflow, /actual_source.*RELEASE_SOURCE_SHA/);
  assert.match(workflow, /actual_digest.*FINAL_IMAGE/);
});

test('recovery stays before migration and refuses Pages rollback after apply step began', () => {
  assert.match(workflow, /steps\.apply-contract\.outcome == 'skipped'/);
  assert.ok(workflow.indexOf('Capture Pages recovery point') < workflow.indexOf('Prepare atomic Phase 2 maintenance window'));
  const apply = workflow.slice(workflow.indexOf('      - name: Apply migrations and start verified release'));
  assert.ok(apply.indexOf('mark-migration') < apply.indexOf('release-migrate apply-contract'));
  assert.match(workflow, /full_commit_message: Deploy \$\{\{ github.sha \}\} \(run \$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}\)/);
  assert.match(workflow, /steps.restore-pages.outcome == 'success'/);
});

test('online preflight rejects metric reset and arbitrary CLI inputs before running', () => {
  const deploy = readFileSync(new URL('./deploy.sh', import.meta.url), 'utf8');
  const start = deploy.indexOf('do_online_contract_preflight() {');
  const end = deploy.indexOf('\ndo_contract_preflight()', start);
  const fn = deploy.slice(start, end);
  const run = args => spawnSync('bash', ['-eu', '-c', `${fn}\nrun_release_entry() { echo invoked; }\ndo_online_contract_preflight "$@"`, '--', ...args], { encoding: 'utf8' });
  for (const profile of ['image-bridge-36', 'image-bridge-traffic']) assert.equal(run(['--observation-exception-id=reviewed-20260910', `--exception-profile=${profile}`]).status, 0);
  for (const args of [['--reset-observation'], ['--apply'], ['--exception-profile=other'], ['--observation-exception-id=../oops']]) {
    const result = run(args);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /invoked/);
  }
});


test('traffic profile requires phase2 and explicit exception authorization', () => {
  const profile = { EXCEPTION_PROFILE: 'image-bridge-traffic' };
  assert.equal(authorize({ ...exception, ...profile }).status, 0);
  for (const invalid of [
    { OBSERVATION_EXCEPTION_ID: '' }, { OBSERVATION_ATTESTATION: '' },
    { RELEASE_PHASE: 'release', FINAL_IMAGE: '' }, { RELEASE_PHASE: 'snapshot', FINAL_IMAGE: '' },
    { RELEASE_PHASE: 'preflight', FINAL_IMAGE: '' }, { RELEASE_PHASE: 'phase1' },
    { RELEASE_PHASE: 'phase2-forward-fix' },
  ]) assert.notEqual(authorize({ ...exception, ...profile, ...invalid }).status, 0);
});

test('traffic and fixed profiles are forwarded exactly across online, drained and migration gates', () => {
  assert.match(workflow, /options: \[age-only, image-bridge-36, image-bridge-traffic\]/);
  assert.equal((workflow.match(/preflight_args\+=\("--exception-profile=\$\{EXCEPTION_PROFILE\}"\)/g) ?? []).length, 3);
  assert.equal((workflow.match(/migration_args\+=\(--exception-profile "\$\{EXCEPTION_PROFILE\}"\)/g) ?? []).length, 2);
  assert.equal((workflow.match(/EXCEPTION_PROFILE:-age-only\}" = image-bridge-traffic/g) ?? []).length, 3);
  const build = readFileSync(new URL('../.github/workflows/deploy-api.yml', import.meta.url), 'utf8');
  assert.match(build, /20260822000003_canonical_asset_contract_image_bridge_traffic\/migration.sql/);
  assert.match(build, /20260821992000_release_image_bridge_traffic/);
});
