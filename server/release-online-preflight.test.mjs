import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./release-online-preflight.sh', import.meta.url));
const sourceRevision = 'a'.repeat(40);
const imageId = 'b'.repeat(64);
const imageDigest = `sha256:${'c'.repeat(64)}`;

const blockerNames = [
  'legacyOnlyActiveAssets', 'unresolvedRepresentations', 'missingObjects', 'objectMetadataMismatches',
  'duplicateCanonicalOwnership', 'malformedWebglDeployments', 'legacyBridgeObservations',
  'playbackOrphans', 'unknownInventoryOwnership', 'activeLegacyUploadSessions',
  'bucketPolicyViolations', 'activeGarageMultipartUploads', 'pendingCleanupOutbox',
  'incompleteObjectRelocations',
];

function report({ blockers = {}, clean = undefined } = {}) {
  const blockerValues = Object.fromEntries(blockerNames.map((name) => [name, {
    count: blockers[name] ?? 0,
    samples: ['private-row-value-that-must-not-reach-stdout'],
  }]));
  return JSON.stringify({
    version: 2,
    startedAt: '2026-09-10T00:00:00.000Z',
    finishedAt: '2026-09-10T00:00:01.000Z',
    inventorySnapshot: { identity: 'private-garage-inventory', capturedAt: '2026-09-10T00:00:00.000Z', objectCount: 2 },
    counts: {
      legacyRowsTotal: 2, legacyRowsTerminal: 0, backfilledCanonicalRows: 2,
      verifiedCanonicalObjects: 2, verifiedRelocationSources: 0, physicalCopies: 0,
      generatedRenditions: 0, unresolvedRows: 0, orphanObjects: 0, duplicateOwnership: 0,
      legacyFallbackReads: 0,
    },
    blockers: blockerValues,
    clean: clean ?? blockerNames.every((name) => (blockers[name] ?? 0) === 0),
    metricObservationReset: false,
  });
}

function run({ exitCode = 0, stdout = report(), drift = false, observation = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pcu-online-preflight-test-'));
  const bin = join(dir, 'bin');
  const trace = join(dir, 'trace');
  const reportFile = join(dir, 'cli-output.json');
  mkdirSync(bin);
  writeFileSync(trace, '');
  writeFileSync(reportFile, stdout);
  if (observation) {
    mkdirSync(join(dir, 'cutover-state'));
    writeFileSync(join(dir, 'cutover-state', 'phase1-observation'), [
      'read_cutover_at=2026-09-09T00:00:00Z',
      `phase1_api_image=ghcr.io/pcugame/pcu-graduationproject-v2-api@${imageDigest}`,
      `migration_image=ghcr.io/pcugame/pcu-graduationproject-v2-api@${imageDigest}`,
      `phase1_image_digest=${imageDigest}`,
      `migration_image_digest=${imageDigest}`,
      `phase1_image_id=${imageId}`,
      `phase1_source_sha=${sourceRevision}`,
      '',
    ].join('\n'));
  }
  writeFileSync(join(bin, 'podman'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$TEST_TRACE"
case "$1" in
  inspect)
    if [[ "$*" == *'{{.State.Status}}'* ]]; then printf running; exit 0; fi
    if [[ "$*" == *'{{.Image}}'* ]]; then
      count=0; [[ -f "$TEST_IMAGE_COUNT" ]] && count="$(<"$TEST_IMAGE_COUNT")"
      count=$((count + 1)); printf '%s' "$count" > "$TEST_IMAGE_COUNT"
      if [[ "\${TEST_DRIFT:-0}" == 1 && "$count" -gt 1 ]]; then printf 'sha256:${'d'.repeat(64)}'; else printf 'sha256:${imageId}'; fi
      exit 0
    fi
    exit 1 ;;
  image)
    if [[ "$*" == *'.Digest'* ]]; then
      if [[ "$*" == *'${'d'.repeat(64)}'* ]]; then printf 'sha256:${'e'.repeat(64)}'; else printf '${imageDigest}'; fi
      exit 0
    fi
    if [[ "$*" == *'org.opencontainers.image.revision'* ]]; then
      if [[ "$*" == *'${'d'.repeat(64)}'* ]]; then printf '${'f'.repeat(40)}'; else printf '${sourceRevision}'; fi
      exit 0
    fi
    exit 1 ;;
  exec)
    cat "$TEST_REPORT_FILE"
    printf 'private stderr: student@example.test' >&2
    exit "\${TEST_EXIT_CODE:-0}" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  const result = spawnSync('bash', [script, sourceRevision], {
    encoding: 'utf8',
    env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, DEPLOY_DIR: dir,
      TEST_TRACE: trace, TEST_REPORT_FILE: reportFile, TEST_EXIT_CODE: String(exitCode),
      TEST_IMAGE_COUNT: join(dir, 'image-count'), TEST_DRIFT: drift ? '1' : '0',
    },
  });
  const audits = readdirSync(join(dir, 'cutover-state')).filter((entry) => entry.startsWith('online-preflight-'));
  return { ...result, dir, audits, trace: readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean) };
}

function remove(result) { rmSync(result.dir, { recursive: true, force: true }); }

test('runs the current API compiled CLI read-only, stores raw output privately, and prints only safe counts', () => {
  const result = run();
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.audits.length, 1);
    const audit = join(result.dir, 'cutover-state', result.audits[0]);
    assert.equal(statSync(audit).mode & 0o777, 0o700);
    for (const file of readdirSync(audit)) assert.equal(statSync(join(audit, file)).mode & 0o777, 0o600, file);
    assert.match(result.stdout, /online_preflight_audit_path=/);
    assert.match(result.stdout, /control_source_revision=aaaaaaaa/);
    assert.match(result.stdout, /api_before_image_digest=sha256:/);
    assert.match(result.stdout, /phase1_observation_read_cutover_at=2026-09-09T00:00:00Z/);
    assert.match(result.stdout, /phase1_observation_runtime=match/);
    assert.match(result.stdout, /blocker_missingObjects=0/);
    assert.match(result.stdout, /legacyFallbackReads=0/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /student@example\.test|private-row-value|private-garage-inventory/);
    assert.match(readFileSync(join(audit, 'preflight.stderr'), 'utf8'), /student@example\.test/);
    assert.match(readFileSync(join(audit, 'preflight.stdout'), 'utf8'), /private-row-value/);
    assert.deepEqual(result.trace.filter((line) => line.startsWith('exec ')), [
      'exec gp-api node dist-release/scripts/preflight-canonical-contract.js --batch-size=5 --head-timeout-ms=5000',
    ]);
    assert(!result.trace.some((line) => /\b(run|stop|start|drain|reset|cp)\b/.test(line)));
  } finally { remove(result); }
});

test('preserves a validated blocker result without exposing samples', () => {
  const result = run({ exitCode: 1, stdout: report({ blockers: { missingObjects: 3 } }) });
  try {
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stdout, /blocker_missingObjects=3/);
    assert.match(result.stdout, /preflight_clean=false/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /private-row-value/);
  } finally { remove(result); }
});

test('treats a CLI operational error as an audit error without printing its private stderr', () => {
  const result = run({ exitCode: 2, stdout: '' });
  try {
    assert.equal(result.status, 2);
    assert.match(result.stderr, /preflight_result=operational-error/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /student@example\.test/);
  } finally { remove(result); }
});

test('fails closed when a zero exit returns a partial report', () => {
  const result = run({ stdout: JSON.stringify({ version: 2, clean: true }) });
  try {
    assert.equal(result.status, 2);
    assert.match(result.stderr, /report is missing, partial, or malformed/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /private-row-value/);
  } finally { remove(result); }
});

test('fails closed when gp-api changes while the online audit runs', () => {
  const result = run({ drift: true });
  try {
    assert.equal(result.status, 2);
    assert.match(result.stderr, /runtime_drift=detected/);
    assert.match(result.stdout, /phase1_observation_runtime=stale/);
  } finally { remove(result); }
});
