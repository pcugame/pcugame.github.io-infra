import { deploySource } from './deploy-source.test-helper.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./ip-ban-audit.sh', import.meta.url));

function run(mode, { beforeCounts = '3|2', afterCounts = '0|3|1|0|2|1|0', enabled = 'false', fail = '', apiExit = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pcu-ip-ban-audit-'));
  const bin = join(dir, 'bin');
  const trace = join(dir, 'trace');
  const sqlFile = join(dir, 'sql');
  writeFileSync(trace, '');
  writeFileSync(sqlFile, '');
  mkdirSync(bin);
  writeFileSync(join(bin, 'podman'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$TEST_TRACE"
case "$1:$2" in
  exec:gp-api)
    [[ "$3" == node ]] || exit 90
    if [[ "$TEST_AUTO_ENABLED" == false ]]; then printf true; else printf false; fi
    exit "\${TEST_API_EXIT:-0}" ;;
  exec:-i)
    [[ "$3" == gp-postgres && "$4" == sh && "$5" == -c ]] || exit 89
    cat > "$TEST_SQL_FILE"
    if [[ "\${TEST_FAIL:-}" == sql ]]; then exit 91; fi
    if grep -q 'reason IN' "$TEST_SQL_FILE"; then printf '%s' "$TEST_BEFORE_COUNTS"; else printf '%s' "$TEST_AFTER_COUNTS"; fi
    exit 0 ;;
  *) exit 92 ;;
esac
`, { mode: 0o755 });
  const result = spawnSync('bash', [script, mode], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TEST_TRACE: trace,
      TEST_SQL_FILE: sqlFile,
      TEST_BEFORE_COUNTS: beforeCounts,
      TEST_AFTER_COUNTS: afterCounts,
      TEST_AUTO_ENABLED: enabled,
      TEST_FAIL: fail,
      TEST_API_EXIT: String(apiExit),
    },
  });
  return {
    ...result,
    dir,
    trace: readFileSync(trace, 'utf8'),
    sql: readFileSync(sqlFile, 'utf8'),
  };
}

function cleanup(result) { rmSync(result.dir, { recursive: true, force: true }); }

test('before prints only AUTO-candidate and legacy totals from read-only SQL', () => {
  const result = run('before');
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /auto_candidates=3/);
    assert.match(result.stdout, /legacy=2/);
    assert.match(result.sql, /BEGIN READ ONLY/);
    assert.match(result.sql, /'Rate limit exceeded \(game download\)'/);
    assert.match(result.sql, /'Rate limit exceeded \(protected asset download\)'/);
    assert.match(result.sql, /'Protected download IP abuse ceiling exceeded'/);
    assert.doesNotMatch(result.sql, /\b(INSERT|UPDATE|DELETE|ALTER|DROP)\b/i);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /203\.0\.113|private reason/i);
    assert.match(result.trace, /exec -i gp-postgres sh -c/);
  } finally { cleanup(result); }
});

test('after checks the API flag and prints aggregate source and disabled counts', () => {
  const result = run('after');
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /download_auto_ip_ban_enabled=false/);
    assert.match(result.stdout, /auto_active=0/);
    assert.match(result.stdout, /auto_disabled=3/);
    assert.match(result.stdout, /manual_active=1/);
    assert.match(result.stdout, /legacy_active=2/);
    assert.match(result.stdout, /legacy_disabled=1/);
    assert.match(result.sql, /BEGIN READ ONLY/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /203\.0\.113|private reason/i);
    assert.match(result.trace, /exec gp-api node -e/);
    assert.match(result.trace, /exec -i gp-postgres sh -c/);
  } finally { cleanup(result); }
});

test('after fails closed when the automatic-ban setting is enabled or missing', () => {
  for (const enabled of ['true', '']) {
    const result = run('after', { enabled });
    try {
      assert.equal(result.status, 2);
      assert.match(result.stderr, /DOWNLOAD_AUTO_IP_BAN_ENABLED is not false/);
      assert.doesNotMatch(result.trace, /gp-postgres/);
    } finally { cleanup(result); }
  }
});

test('after fails closed when the API environment inspection command fails', () => {
  const result = run('after', { apiExit: 1 });
  try {
    assert.equal(result.status, 2);
    assert.match(result.stderr, /could not read the API automatic-ban setting/);
    assert.doesNotMatch(result.trace, /gp-postgres/);
  } finally { cleanup(result); }
});

test('after fails if any AUTO row remains active or an unknown source is present', () => {
  for (const afterCounts of ['1|2|1|0|2|1|0', '0|3|1|0|2|1|1']) {
    const result = run('after', { afterCounts });
    try {
      assert.equal(result.status, 2);
      assert.match(result.stderr, afterCounts.startsWith('1|')
        ? /automatic IP bans remain active/
        : /unknown banned-IP source/);
    } finally { cleanup(result); }
  }
});

test('rejects PostgreSQL failures and malformed aggregate output without exposing details', () => {
  for (const options of [{ fail: 'sql' }, { beforeCounts: 'private reason at 203.0.113.8' }]) {
    const result = run('before', options);
    try {
      assert.equal(result.status, 2);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /private reason|203\.0\.113/);
    } finally { cleanup(result); }
  }
});

test('release audits bans before drain and verifies disabled AUTO rows after startup', () => {
  const script = readFileSync(new URL('./release-orchestrate.sh', import.meta.url), 'utf8');
  const preflight = script.slice(script.indexOf('  preflight)'), script.indexOf('  migrate)'));
  assert.ok(preflight.indexOf('ip-ban-audit.sh" before') >= 0);
  assert.ok(preflight.indexOf('ip-ban-audit.sh" before') < preflight.indexOf('deploy drain'));
  const activate = script.slice(script.indexOf('  activate)'), script.indexOf('  health)'));
  assert.ok(activate.indexOf('deploy up') >= 0);
  assert.ok(activate.indexOf('ip-ban-audit.sh" after') > activate.indexOf('deploy up'));
  const workflow = readFileSync(new URL('../.github/workflows/release-api-cutover.yml', import.meta.url), 'utf8');
  assert.ok(workflow.indexOf('release-orchestrate.sh" activate') < workflow.indexOf('release-orchestrate.sh" smoke'));

  const deployScript = deploySource();
  assert.match(deployScript, /load_runtime_env/);
  const apiUnit = readFileSync(new URL('./quadlet/templates/gp-api.container.in', import.meta.url), 'utf8');
  assert.match(apiUnit, /EnvironmentFile=@API_ENV@/);
  const runtimeEnv = readFileSync(new URL('./quadlet/runtime-env.py', import.meta.url), 'utf8');
  assert.match(runtimeEnv, /DOWNLOAD_AUTO_IP_BAN_ENABLED='false'/);
  const exampleEnv = readFileSync(new URL('./.env.example', import.meta.url), 'utf8');
  assert.match(exampleEnv, /^DOWNLOAD_AUTO_IP_BAN_ENABLED=false$/m);
});
