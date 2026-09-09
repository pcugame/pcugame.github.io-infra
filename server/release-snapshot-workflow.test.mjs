import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/release-api-cutover.yml', import.meta.url), 'utf8');
const snapshot = workflow.slice(workflow.indexOf('\n  snapshot:'), workflow.indexOf('\n  cutover:'));
const authorization = workflow.slice(workflow.indexOf('          if [ "${RELEASE_PHASE}" = snapshot ]; then'), workflow.indexOf('          elif [ "${RELEASE_PHASE}" = phase1 ]; then'));

test('snapshot accepts no deployment or false observation inputs', () => {
  const script = `${authorization}\nfi`;
  const base = { ...process.env, RELEASE_PHASE: 'snapshot', PHASE1_IMAGE: '', PHASE1_SOURCE_SHA: '', FINAL_IMAGE: '', OBSERVATION_STARTED_AT: '', OBSERVATION_ATTESTATION: '' };
  assert.equal(spawnSync('bash', ['-eu', '-c', script], { env: base }).status, 0);
  for (const key of ['PHASE1_IMAGE', 'PHASE1_SOURCE_SHA', 'FINAL_IMAGE', 'OBSERVATION_STARTED_AT', 'OBSERVATION_ATTESTATION']) {
    assert.notEqual(spawnSync('bash', ['-eu', '-c', script], { env: { ...base, [key]: 'unexpected' } }).status, 0, key);
  }
});

test('snapshot and cutover jobs are mutually exclusive under the existing production lock', () => {
  assert.match(workflow, /group: production-object-cutover/);
  assert.match(snapshot, /if: \$\{\{ inputs.phase == 'snapshot' \}\}/);
  assert.match(workflow.slice(workflow.indexOf('\n  cutover:')), /if: \$\{\{ inputs.phase != 'snapshot' \}\}/);
  assert.match(snapshot, /needs: authorize/);
  assert.match(snapshot, /environment: production/);
  assert.match(snapshot, /verify-github-release-boundaries.mjs control/);
  assert.match(snapshot, /RELEASE_SOURCE_SHA: \$\{\{ github.sha \}\}/);
  assert.match(snapshot, /bash "\$\{DEPLOY_DIR\}\/release-db-snapshot.sh"/);
  assert.doesNotMatch(snapshot, /deploy\.sh|apply-contract|pg_restore|actions-gh-pages|upload-artifact|GHCR_TOKEN/);
});
