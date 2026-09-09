import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./release-db-snapshot.sh', import.meta.url));
const sourceRevision = 'a'.repeat(40);
const imageId = 'b'.repeat(64);

function run(extra = {}, args = [sourceRevision]) {
  const dir = mkdtempSync(join(tmpdir(), 'pcu-db-snapshot-test-'));
  const bin = join(dir, 'bin');
  const trace = join(dir, 'trace');
  mkdirSync(bin);
  writeFileSync(trace, '');
  const executable = (name, body) => writeFileSync(join(bin, name), `#!/usr/bin/env bash\nset -euo pipefail\n${body}`, { mode: 0o755 });
  executable('podman', `
printf '%s\\n' "$*" >> "$TEST_TRACE"
payload="$(cat)"
case "$1" in
  inspect)
    if [[ "$*" == *gp-postgres* ]]; then printf running; exit 0; fi
    if [[ "$*" == *gp-api* ]]; then printf 'sha256:${imageId}'; exit 0; fi
    exit 1 ;;
  image)
    [[ "$2" == inspect && "$*" == *'.Digest'* ]] && { printf 'sha256:${'c'.repeat(64)}'; exit 0; }
    [[ "$2" == inspect ]] && { printf '${sourceRevision}'; exit 0; }
    exit 1 ;;
  exec)
    joined="$* $payload"
    if [[ "$joined" == *pg_dump* ]]; then
      [[ "\${TEST_DUMP_FAIL:-}" != 1 ]] || exit 9
      printf 'custom archive bytes'; exit 0
    fi
    if [[ "$joined" == *'pg_restore --list'* ]]; then exit 0; fi
    if [[ "$joined" == *'pg_restore --exit-on-error'* ]]; then
      if [[ "\${TEST_RESTORE_FAIL:-}" == 1 ]]; then
        printf 'private restored value: student@example.test' >&2
        exit 10
      fi
      exit 0
    fi
    if [[ "$joined" == *pg_isready* ]]; then exit 0; fi
    if [[ "$joined" == *pg_database_size* ]]; then printf 1024; exit 0; fi
    if [[ "$joined" == *psql* ]]; then
      if [[ "$joined" == *snapshot_table_counts* ]]; then printf '{"public.assets":2}\\n';
      elif [[ "$joined" == *snapshot_migration_metrics* ]]; then printf '[{"name":"pending","scope":"global","value":0,"last_observed_at":null}]\\n';
      else printf '[]\\n'; fi
      exit 0
    fi
    exit 0 ;;
  run) printf 'container-id'; exit 0 ;;
  rm) exit 0 ;;
  *) exit 1 ;;
esac
`);
  try {
    const result = spawnSync('bash', [script, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DEPLOY_DIR: dir, TEST_TRACE: trace, ...extra },
    });
    const backups = join(dir, 'backups');
    return {
      ...result,
      trace: readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean),
      backupEntries: (() => { try { return readdirSync(backups); } catch { return []; } })(),
      dir,
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function remove(result) { rmSync(result.dir, { recursive: true, force: true }); }

test('creates a private online dump, verifies it, rehearses an isolated restore, and records only metadata', () => {
  const result = run();
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.backupEntries.length, 1);
    const snapshot = join(result.dir, 'backups', result.backupEntries[0]);
    assert.equal(statSync(snapshot).mode & 0o777, 0o700);
    assert.match(readFileSync(join(snapshot, 'database.dump.sha256'), 'utf8'), /^[0-9a-f]{64}\s{2}\/.+\/database\.dump\n$/);
    const receipt = JSON.parse(readFileSync(join(snapshot, 'receipt.json'), 'utf8'));
    assert.equal(receipt.control_source_revision, sourceRevision);
    assert.equal(receipt.api_image_id, imageId);
    assert.equal(receipt.api_image_digest, `sha256:${'c'.repeat(64)}`);
    assert.equal(receipt.api_image_revision, sourceRevision);
    assert.deepEqual(JSON.parse(readFileSync(join(snapshot, 'restored-table-counts.json'), 'utf8')), { 'public.assets': 2 });
    assert.deepEqual(JSON.parse(readFileSync(join(snapshot, 'restored-migrations.json'), 'utf8')), []);
    assert.deepEqual(JSON.parse(readFileSync(join(snapshot, 'restored-migration-metrics.json'), 'utf8')), [
      { name: 'pending', scope: 'global', value: 0, last_observed_at: null },
    ]);
    assert(result.trace.some((line) => line.includes('pg_dump --format=custom --lock-wait-timeout=10s')));
    assert(result.trace.some((line) => line.includes('pg_restore --list')));
    const rehearsalRun = result.trace.find((line) => line.startsWith('run '));
    assert.match(rehearsalRun, /--network none/);
    assert.match(rehearsalRun, /--tmpfs \/var\/lib\/postgresql\/data/);
    assert.doesNotMatch(rehearsalRun, /-p |--publish|gp_pg_data/);
    assert(result.trace.some((line) => line.startsWith('rm -f pcu-snapshot-restore-')));
    assert(!result.trace.some((line) => /\b(stop|start|restart|kill|cp)\b/.test(line)), 'snapshot must not mutate production runtime');
  } finally { remove(result); }
});

test('removes its incomplete snapshot when the online dump fails before any rehearsal starts', () => {
  const result = run({ TEST_DUMP_FAIL: '1' });
  try {
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.backupEntries, []);
    assert(!result.trace.some((line) => line.startsWith('run ')));
    assert(!result.trace.some((line) => line.startsWith('rm -f ')));
  } finally { remove(result); }
});

test('removes only its generated rehearsal container and preserves a verified dump with a failed receipt when restore fails', () => {
  const result = run({ TEST_RESTORE_FAIL: '1' });
  try {
    assert.notEqual(result.status, 0);
    assert.equal(result.backupEntries.length, 1);
    const snapshot = join(result.dir, 'backups', result.backupEntries[0]);
    const receipt = JSON.parse(readFileSync(join(snapshot, 'receipt.json'), 'utf8'));
    assert.deepEqual(receipt.snapshot_status, 'failed');
    assert.equal(receipt.failure_stage, 'rehearsal_restore');
    assert.match(readFileSync(join(snapshot, 'database.dump.sha256'), 'utf8'), /^[0-9a-f]{64}/);
    assert.match(readFileSync(join(snapshot, 'rehearsal-restore.stderr'), 'utf8'), /student@example\.test/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /student@example\.test/);
    const removals = result.trace.filter((line) => line.startsWith('rm -f '));
    assert.equal(removals.length, 1);
    assert.match(removals[0], /^rm -f pcu-snapshot-restore-[A-Za-z0-9]+$/);
  } finally { remove(result); }
});

test('rejects malformed source or container identifiers before dumping', () => {
  for (const [extra, args] of [
    [{}, ['main']],
    [{ PG_CONTAINER: 'gp-postgres; stop gp-api' }, [sourceRevision]],
  ]) {
    const result = run(extra, args);
    try {
      assert.notEqual(result.status, 0);
      assert(!result.trace.some((line) => line.includes('pg_dump')));
    } finally { remove(result); }
  }
});
