import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('./release-phase1-video-update.sh', import.meta.url));
const digest = `ghcr.io/pcugame/pcu-graduationproject-v2-api@sha256:${'a'.repeat(64)}`;
function run(extra = {}, args = [digest, 'b'.repeat(40)]) {
  const dir = mkdtempSync(join(tmpdir(), 'video-release-test-'));
  try {
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, '.env'), 'API_PUBLIC_URL=https://api.test\n' + (extra.TEST_ENV || ''));
    const executable = (path, body) => writeFileSync(path, '#!/usr/bin/env bash\nset -euo pipefail\n' + body, { mode: 0o755 });
    executable(join(dir, 'deploy.sh'), 'echo "$*" >> "$TEST_TRACE"\n[[ "$*" != "${TEST_FAIL:-}" ]]\n');
    executable(join(dir, 'bin', 'curl'), 'echo "health" >> "$TEST_TRACE"\nwhile [[ $# -gt 0 ]]; do if [[ $1 == --output ]]; then shift; echo {} > "$1"; fi; shift; done\nprintf 200\n');
    executable(join(dir, 'bin', 'podman'), `
if [[ "$1" == run ]]; then exit 0; fi
sql="$(cat)"
if [[ "$sql" == *'_prisma_migrations'* ]]; then echo "\${TEST_HISTORY:-1|0|0}";
elif [[ "$sql" == *'SELECT count(*) FROM assets a'* ]]; then echo \"\${TEST_UNAVAILABLE:-0}\";
elif [[ "$sql" == *'SELECT id, project_id'* ]]; then
  echo '1|7||VIDEO|READY|source|playback'
  if [[ "\${TEST_TAMPER:-}" == 1 && -f "$DEPLOY_DIR/snapshot" ]]; then echo changed; fi
  touch "$DEPLOY_DIR/snapshot"
else echo 'ready_videos=133,main_videos=133'; fi
`);
    const trace = join(dir, 'trace');
    writeFileSync(trace, '');
    const result = spawnSync('bash', [script, ...args], {
      env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, DEPLOY_DIR: dir, TEST_TRACE: trace, ...extra }, encoding: 'utf8',
    });
    return { ...result, trace: readFileSync(trace, 'utf8').trim().split('\n') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('runs backup and identity audit before additive update, starts only after validation', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.trace, [
    'release-artifact-preflight phase1', 'capacity-preflight', 'drain', `backup video-order-${'b'.repeat(40)}`,
    'release-migrate apply-expand', 'release-assert phase1', 'up', 'release-assert phase1', 'health',
  ]);
});
test('rejects mutable images and malformed revisions without touching runtime', () => {
  for (const args of [[digest.replace(/@sha256:.+/, ':latest'), 'b'.repeat(40)], [digest, 'main']]) {
    const result = run({}, args);
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.trace, ['']);
  }
});
test('rejects contract or missing Phase 1 history before drain', () => {
  for (const TEST_HISTORY of ['1|1|0', '0|0|0', '1|0|1']) {
    const result = run({ TEST_HISTORY });
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.trace, ['release-artifact-preflight phase1', 'capacity-preflight']);
  }
});
test('backup failure leaves mutations drained and does not migrate', () => {
  const result = run({ TEST_FAIL: `backup video-order-${'b'.repeat(40)}` });
  assert.notEqual(result.status, 0);
  assert.equal(result.trace.at(-1), 'drain');
  assert(!result.trace.includes('release-migrate apply-expand'));
});
test('asset identity drift refuses runtime restart and keeps mutations drained', () => {
  const result = run({ TEST_TAMPER: '1' });
  assert.notEqual(result.status, 0);
  assert(!result.trace.includes('up'));
  assert.equal(result.trace.at(-1), 'drain');
});
test('runtime restart failure drains again without running contract or backfill', () => {
  const result = run({ TEST_FAIL: 'up' });
  assert.notEqual(result.status, 0);
  assert.equal(result.trace.at(-1), 'drain');
  assert(!result.trace.some((line) => /apply-contract|backfill/.test(line)));
});

test('conflicting configured image fails before any release control action', () => {
  const result = run({ TEST_ENV: 'API_IMAGE=unexpected:latest\n' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.trace, ['']);
});
test('capacity failure does not stop the existing runtime', () => {
  const result = run({ TEST_FAIL: 'capacity-preflight' });
  assert.notEqual(result.status, 0);
  assert(!result.trace.includes('drain'));
});

test('API-only deployment refuses videos that require the new web fallback before maintenance', () => {
  const result = run({ TEST_UNAVAILABLE: '1' });
  assert.notEqual(result.status, 0);
  assert(!result.trace.includes('drain'));
});
