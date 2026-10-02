import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const source = readFileSync(new URL('./deploy.sh', import.meta.url), 'utf8');
function definition(name) {
  const match = source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'));
  assert.ok(match, `missing ${name}`);
  return match[0];
}
function run(script) { return spawnSync('bash', ['-euc', script], { encoding: 'utf8' }); }

test('correction and rollback commands are retired without invoking the release CLI', () => {
  assert.doesNotMatch(source, /do_canonical_correction|correct-canonical-assets|assert_legacy_material_rollback_safe|ROLLBACK_AUTH_NONCE/);
  for (const command of ['correction', 'authorize-phase1-rollback']) {
    const result = spawnSync('bash', [new URL('./deploy.sh', import.meta.url).pathname, command], {
      encoding: 'utf8', env: { ...process.env, DEPLOY_DIR: '/nonexistent-retired-command-fixture' },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /Usage:/);
    assert.doesNotMatch(result.stdout, /\.env file not found/);
  }
});

test('routine artifact preflight requires migration and inventory CLIs only', () => {
  const result = run(`${definition('validate_release_entries')}
MIGRATION_IMAGE=fixture
podman() { printf '%s\\n' "$@"; }
validate_release_entries`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dist-release\/scripts\/release-migrate\.js/);
  assert.match(result.stdout, /dist-release\/scripts\/snapshot-garage-inventory\.js/);
  assert.doesNotMatch(result.stdout, /backfill-canonical-assets|preflight-canonical-contract|verify-cutover-report|correct-canonical-assets/);
});

test('routine migration rejects expand and exception arguments before drain or CLI', () => {
  for (const args of ['apply-expand', 'apply-contract --observation-exception-id=retired', 'status --exception-profile=image-bridge-36']) {
    const result = run(`${definition('do_release_migration')}
assert_mutation_drained() { echo drained; }
run_release_entry() { echo invoked; }
do_release_migration ${args}`);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /drained|invoked/);
  }
});

test('routine contract migration still fails before CLI unless mutations are drained', () => {
  const result = run(`${definition('do_release_migration')}
assert_mutation_drained() { return 19; }
run_release_entry() { echo invoked; }
do_release_migration apply-contract`);
  assert.equal(result.status, 19);
  assert.doesNotMatch(result.stdout, /invoked/);
});

test('routine migration status is read-only and contract apply preserves the release entry', () => {
  for (const action of ['status', 'apply-contract']) {
    const result = run(`${definition('do_release_migration')}
assert_mutation_drained() { echo drained; }
run_release_entry() { printf '%s\\n' "$@"; }
do_release_migration ${action}`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes('drained'), action === 'apply-contract');
    assert.match(result.stdout, new RegExp(`dist-release/scripts/release-migrate\\.js\\n${action}\\n$`));
    if (action === 'apply-contract') {
      assert.match(result.stdout, /drained\ndist-release\/scripts\/release-migrate\.js\nassert-runtime\nphase2\ndist-release\/scripts\/release-migrate\.js\napply-contract\n$/);
    } else {
      assert.doesNotMatch(result.stdout, /assert-runtime/);
    }
  }
});

test('direct migration command refuses an uncontracted or invalid-receipt DB before applying SQL', () => {
  const result = run(`${definition('do_release_migration')}
assert_mutation_drained() { echo drained; }
run_release_entry() {
  if [[ "$2" == assert-runtime && "$3" == phase2 ]]; then
    echo schema-rejected
    return 23
  fi
  echo migration-invoked
}
do_release_migration apply-contract`);
  assert.equal(result.status, 23);
  assert.match(result.stdout, /schema-rejected/);
  assert.doesNotMatch(result.stdout, /migration-invoked/);
});
