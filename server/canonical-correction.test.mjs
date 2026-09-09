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

test('preparation runs online but apply fails before invoking the CLI unless drained', () => {
  for (const stage of ['investigate', 'prepare', 'protect', 'apply']) {
    const result = run(`${definition('do_canonical_correction')}
assert_mutation_drained() { return 19; }
run_release_entry() { echo invoked; }
do_canonical_correction ${stage}`);
    assert.equal(result.status, stage === 'apply' ? 19 : 0);
    assert.equal(result.stdout.includes('invoked'), stage !== 'apply');
  }
});

test('correction release process receives actual 2 GiB memory and swap limits', () => {
  const result = run(`${definition('run_release_entry')}
load_env() { :; }
validate_production_boundaries() { :; }
require_immutable_release_images() { :; }
validate_release_source_identity() { :; }
assert_postgres_running() { :; }
release_common_args() { RELEASE_CONTAINER_ARGS=(--rm); }
podman() { printf '%s\\n' "$@"; }
CUTOVER_STATE_DIR=/tmp
MIGRATION_IMAGE=fixture
run_release_entry dist-release/scripts/correct-canonical-assets.js prepare --manifest=/release-state/review.json`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--memory=2g\n--memory-swap=2g/);
  assert.match(result.stdout, /prepare\n--manifest=\/release-state\/review.json/);
});

test('legacy rollback rejects material rows and database failures', () => {
  for (const [value, exit] of [['0', 0], ['1', 0], ['', 3], ['invalid', 0]]) {
    const result = run(`${definition('assert_legacy_material_rollback_safe')}
PG_CONTAINER=fixture
podman() { cat >/dev/null; echo '${value}'; return ${exit}; }
assert_legacy_material_rollback_safe`);
    assert.equal(result.status === 0, value === '0' && exit === 0);
  }
  assert.match(definition('assert_phase1_rollback_authorization'), /assert_legacy_material_rollback_safe/);
});
