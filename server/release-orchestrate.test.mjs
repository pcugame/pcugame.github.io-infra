import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = resolve('server/release-orchestrate.sh');
const source = 'a'.repeat(40), digest = `sha256:${'b'.repeat(64)}`;
function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'release-orchestration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'cutover-state'));
  const write = (name, body) => writeFileSync(join(dir, name), body, { mode: 0o700 });
  write('deploy.sh', `#!/usr/bin/env bash
set -eu
printf 'deploy %s\\n' "$*" >> "$EVENTS"
[[ "$*" != "\${FAIL_STAGE:-}" ]]
`);
  for (const file of ['ip-ban-audit.sh', 'release-db-snapshot.sh']) write(file, `#!/usr/bin/env bash
set -eu
printf '${file} %s\\n' "$*" >> "$EVENTS"
[[ '${file}' != "\${FAIL_STAGE:-}" ]]
`);
  for (const name of ['release-recovery', 'release-smoke-target', 'smoke-data-plane']) write(`${name}.mjs`, `
import { appendFileSync, writeFileSync, existsSync } from 'node:fs';
appendFileSync(process.env.EVENTS, '${name} ' + process.argv.slice(2).join(' ') + '\\n');
if (process.argv[2] === 'mark-migration') writeFileSync(process.env.ATTEMPT, 'attempted');
if (process.argv[2] === 'recover' && existsSync(process.env.ATTEMPT)) process.exit(1);
if ('${name}' === process.env.FAIL_STAGE || process.argv[2] === process.env.FAIL_STAGE) process.exit(1);
if (process.argv[2] === 'read') console.log('https://example.test/object');
`);
  write('bin/podman', `#!/usr/bin/env bash
set -eu
case "$*" in
  login*) cat >/dev/null ;;
  *State.Status*) echo running ;;
  *image\\ inspect*revision*) if [[ "\${3:-}" == gp-worker-video && "\${FAIL_STAGE:-}" == worker-source ]]; then echo wrong; exit; fi; echo "\${ACTUAL_SOURCE:-$RELEASE_SOURCE_SHA}" ;;
  *image\\ inspect*Digest*) if [[ "\${3:-}" == gp-worker-video && "\${FAIL_STAGE:-}" == worker-digest ]]; then echo wrong; exit; fi; echo "\${ACTUAL_DIGEST:-\${FINAL_IMAGE##*@}}" ;;
  inspect*) echo "$2" ;;
  exec*) printf 'health checked\\n' >> "$EVENTS"; [[ "\${FAIL_STAGE:-}" != health ]]; echo '{"ok":true}' ;;
  *) exit 1 ;;
esac
`);
  write('bin/sleep', '#!/usr/bin/env bash\nexit 0\n');
  write('bin/systemctl', '#!/usr/bin/env bash\n[[ "${FAIL_STAGE:-}" != worker ]] || exit 1\necho active\n');
  const env = { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, DEPLOY_DIR: dir,
    RELEASE_SOURCE_SHA: source, FINAL_IMAGE: `ghcr.io/pcugame/pcu-graduationproject-v2-api@${digest}`,
    RELEASE_RUN_KEY: '123-1', GHCR_TOKEN: 'fixture', GHCR_USERNAME: 'fixture',
    EVENTS: join(dir, 'events'), ATTEMPT: join(dir, 'attempt'), ...overrides };
  const run = stage => spawnSync('bash', [script, stage], { env, encoding: 'utf8' });
  const events = () => existsSync(env.EVENTS) ? readFileSync(env.EVENTS, 'utf8') : '';
  const evidence = () => existsSync(join(dir, 'cutover-state', `deployed-${source}.txt`));
  const release = () => {
    for (const stage of ['preflight', 'backup', 'migrate', 'activate', 'health']) {
      const result = run(stage); if (result.status !== 0) return result;
    }
    writeFileSync(env.EVENTS, events() + 'publish\n');
    return run('smoke');
  };
  return { run, release, events, evidence, env };
}

test('normal orchestration preserves phase order and records only verified final source/digest', t => {
  const f = fixture(t), result = f.release();
  assert.equal(result.status, 0, result.stderr);
  let cursor = -1;
  for (const marker of ['release-artifact-preflight phase2', 'release-assert phase2', 'release-smoke-target prepare', 'ip-ban-audit.sh before', 'release-db-snapshot.sh', 'release-recovery capture', 'deploy drain', 'deploy backup', 'release-recovery mark-migration', 'release-migrate apply-contract', 'deploy up', 'ip-ban-audit.sh after', 'health checked', 'publish', 'verify-final-web', 'smoke-data-plane']) {
    const next = f.events().indexOf(marker, cursor + 1); assert.ok(next > cursor, marker); cursor = next;
  }
  assert.equal(f.evidence(), true);
  const record = readFileSync(join(f.env.DEPLOY_DIR, 'cutover-state', `deployed-${source}.txt`), 'utf8');
  assert.equal(record, `source_sha=${source}\nimage=${f.env.FINAL_IMAGE}\n`);
});
for (const stage of ['release-artifact-preflight phase2', 'release-assert phase2', 'release-db-snapshot.sh', 'drain', 'backup release-'+source, 'release-migrate apply-contract', 'up', 'health', 'worker', 'worker-source', 'worker-digest', 'mark-migration']) {
  test(`failure ${stage} prevents publication and final evidence`, t => {
    const f = fixture(t, { FAIL_STAGE: stage });
    assert.notEqual(f.release().status, 0);
    assert.doesNotMatch(f.events(), /publish/);
    assert.equal(f.evidence(), false);
    if (stage === 'mark-migration') assert.doesNotMatch(f.events(), /apply-contract/);
    if (['release-migrate apply-contract', 'up', 'health', 'worker', 'worker-source', 'worker-digest', 'mark-migration'].includes(stage)) {
      assert.equal(existsSync(f.env.ATTEMPT), true);
      assert.notEqual(f.run('recover').status, 0, 'persistent migration attempt forbids recovery');
    }
  });
}
for (const override of [{ ACTUAL_SOURCE: 'c'.repeat(40) }, { ACTUAL_DIGEST: `sha256:${'c'.repeat(64)}` }]) {
  test(`running runtime identity mismatch ${Object.keys(override)[0]} blocks publication`, t => {
    const f = fixture(t, override);
    assert.notEqual(f.release().status, 0); assert.doesNotMatch(f.events(), /publish/); assert.equal(f.evidence(), false);
  });
}
test('failed data-plane smoke leaves no evidence and cannot recover after migration attempt', t => {
  const f = fixture(t, { FAIL_STAGE: 'smoke-data-plane' });
  assert.notEqual(f.release().status, 0); assert.match(f.events(), /publish/);
  assert.equal(f.evidence(), false); assert.notEqual(f.run('recover').status, 0);
});
test('invalid immutable image or source fails before any external command', t => {
  for (const overrides of [{ FINAL_IMAGE: 'repo:latest' }, { RELEASE_SOURCE_SHA: 'bad' }, { FINAL_IMAGE: `ghcr.io/attacker/api@${digest}` }]) {
    const f = fixture(t, overrides); assert.notEqual(f.run('preflight').status, 0); assert.equal(f.events(), '');
  }
});
test('forward fix is forward-only and does not publish or apply migrations', t => {
  const f = fixture(t); assert.equal(f.run('forward-fix').status, 0);
  assert.doesNotMatch(f.events(), /publish|apply-contract|recover|verify-final-web/);
  assert.match(f.events(), /release-assert phase2/); assert.equal(f.evidence(), true);
});

test('workflow DAG resolves immutable image before production gate and publishes only after health', () => {
  const workflow = readFileSync('.github/workflows/release-api-cutover.yml', 'utf8');
  const job = name => workflow.split(`\n  ${name}:\n`)[1]?.split(/\n  [a-z_]+:\n/)[0];
  assert.match(job('authorize'), /verify-release-source\.mjs/);
  assert.doesNotMatch(job('authorize'), /environment:/);
  assert.match(job('resolve_image'), /needs: authorize/);
  assert.match(job('resolve_image'), /resolve-release-image\.mjs/);
  assert.doesNotMatch(job('resolve_image'), /environment:/);
  assert.match(job('build_image'), /needs: \[authorize, resolve_image\]/);
  assert.match(job('build_image'), /needs\.resolve_image\.outputs\.image == ''/);
  assert.match(job('build_image'), /uses: \.\/\.github\/workflows\/deploy-api\.yml/);
  assert.match(job('cutover'), /needs: \[authorize, resolve_image, build_image\]/);
  assert.match(job('cutover'), /needs\.authorize\.result == 'success'/);
  assert.match(job('cutover'), /needs\.resolve_image\.result == 'success'/);
  assert.match(job('cutover'), /needs\.resolve_image\.outputs\.image != '' \|\| needs\.build_image\.result == 'success'/);
  assert.match(job('cutover'), /environment: production/);
  for (const operation of ['preflight', 'backup', 'migrate', 'activate', 'health', 'smoke']) {
    const step = job('cutover').split(/\n      - /).find(s => s.includes(`release-orchestrate.sh" ${operation}`));
    assert.match(step, /if: \$\{\{ inputs.operation == 'release' \}\}/);
    assert.doesNotMatch(step, /continue-on-error|always\(\)|failure\(\)/);
    assert.match(step, /script_stop: true/);
  }
  const publish = job('cutover').split(/\n      - /).find(s => s.includes('peaceiris/actions-gh-pages'));
  assert.doesNotMatch(publish, /continue-on-error|always\(\)|failure\(\)/);
  assert.match(publish, /full_commit_message: Deploy \$\{\{ github.sha \}\} \(run \$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}\)/);
  assert.match(publish, /if: \$\{\{ inputs.operation == 'release' \}\}/);
  assert.match(job('cutover'), /failure\(\) && steps.capture-pages.outcome == 'success' && steps.migrate.outcome == 'skipped'/);
  assert.match(job('cutover'), /WEB_RECOVERY_VERIFIED: 'true'/);
});

test('exact source verifier rejects foreign repository, branch, malformed SHA and checkout mismatch', t => {
  const dir = mkdtempSync(join(tmpdir(), 'release-source-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'git'), '#!/usr/bin/env bash\nprintf "%s\\n" "$CHECKOUT_SHA"\n', { mode: 0o700 });
  const base = { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_SHA: source, CHECKOUT_SHA: source,
    GITHUB_REPOSITORY: 'pcugame/pcugame.github.io-infra', GITHUB_REF: 'refs/heads/master', GITHUB_DEFAULT_BRANCH: 'master' };
  const run = override => spawnSync(process.execPath, ['server/verify-release-source.mjs'], { env: { ...base, ...override }, encoding: 'utf8' });
  assert.equal(run({}).status, 0);
  for (const override of [{ GITHUB_REPOSITORY: 'fork/repo' }, { GITHUB_REF: 'refs/heads/topic' }, { GITHUB_DEFAULT_BRANCH: 'main' }, { GITHUB_SHA: 'bad' }, { CHECKOUT_SHA: 'c'.repeat(40) }]) assert.notEqual(run(override).status, 0);
});

test('served Web mismatch prevents final evidence and automatic recovery', t => {
  const f = fixture(t, { FAIL_STAGE: 'verify-final-web ' + source });
  assert.notEqual(f.release().status, 0); assert.match(f.events(), /publish/);
  assert.equal(f.evidence(), false); assert.notEqual(f.run('recover').status, 0);
  assert.doesNotMatch(f.events(), /smoke-data-plane/);
});
