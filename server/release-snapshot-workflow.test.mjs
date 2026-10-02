import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/release-api-cutover.yml', import.meta.url), 'utf8');
const snapshot = workflow.slice(workflow.indexOf('\n  snapshot:'), workflow.indexOf('\n  resolve_image:'));
test('snapshot rejects deployment and forward-fix inputs', () => {
 const base = { ...process.env, RELEASE_OPERATION: 'snapshot', FINAL_IMAGE: '', FORWARD_FIX_ACKNOWLEDGEMENT: '', EXPECTED_IMAGE_REPO: 'ghcr.io/pcugame/pcu-graduationproject-v2-api', GITHUB_OUTPUT: '/dev/null' };
 assert.equal(spawnSync('bash', ['server/release-inputs.sh'], { env: base }).status, 0);
 for (const key of ['FINAL_IMAGE', 'FORWARD_FIX_ACKNOWLEDGEMENT']) assert.notEqual(spawnSync('bash', ['server/release-inputs.sh'], { env: { ...base, [key]: 'unexpected' } }).status, 0, key);
});

test('snapshot and cutover jobs are mutually exclusive under the existing production lock', () => {
  assert.match(workflow, /group: production-object-cutover/);
  assert.match(snapshot, /if: \$\{\{ inputs.operation == 'snapshot' \}\}/);
  assert.match(workflow.slice(workflow.indexOf('\n  cutover:')), /inputs.operation != 'snapshot'/);
  assert.match(snapshot, /needs: authorize/);
  assert.match(snapshot, /environment: production/);
  assert.match(snapshot, /verify-release-source.mjs/);
  assert.match(snapshot, /RELEASE_SOURCE_SHA: \$\{\{ github.sha \}\}/);
  assert.match(snapshot, /bash "\$\{DEPLOY_DIR\}\/release-db-snapshot.sh"/);
  assert.doesNotMatch(snapshot, /deploy\.sh|apply-contract|pg_restore|actions-gh-pages|upload-artifact|GHCR_TOKEN/);
});
