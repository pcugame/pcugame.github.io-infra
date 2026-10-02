import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { classifyPaths, selectPlan, writePlan, flags } from './classify-ci-changes.mjs';

const selected = plan => flags.filter(flag => plan[flag]);
const all = plan => assert.deepEqual(selected(plan), flags);

test('classification matrix and mixed changes', () => {
  for (const path of ['apps/web/src/App.tsx', 'apps/web/public/favicon.svg']) {
    assert.deepEqual(selected(classifyPaths([path])), ['web', 'contracts', 'install']);
  }
  for (const path of ['apps/api/src/server.ts', 'apps/api/prisma/schema.prisma',
    'apps/api/prisma/migrations/20990101000000_new/migration.sql',
    'apps/api/prisma/contract-migration-paths/new/migration.sql', 'apps/db/garage.toml',
    'server/deploy/activate.sh', 'server/quadlet/ADOPTION.md']) {
    assert.deepEqual(selected(classifyPaths([path])), ['api', 'contracts', 'release', 'integration', 'install']);
  }
  assert.deepEqual(selected(classifyPaths(['README.md', 'docs/architecture/a.md'])), []);
  assert.deepEqual(selected(classifyPaths(['docs/a.md', 'apps/web/src/a.ts'])), ['web', 'contracts', 'install']);
  all(classifyPaths(['apps/api/src/a.ts', 'apps/web/src/a.ts']));
});

test('shared manifests, startup controls, fixtures and unknowns never narrow', () => {
  for (const path of ['package.json', 'package-lock.json', 'apps/web/package.json',
    'apps/api/package.json', 'packages/contracts/src/index.ts', 'packages/future/src/index.ts',
    '.github/workflows/pr-checks.yml', 'scripts/classify-ci-changes.mjs',
    'scripts/run-integration.mjs', 'scripts/smoke-integration.mjs', 'docker-compose.integration.yml',
    'apps/web/index.html', 'apps/web/vite.config.ts', 'apps/web/scripts/post-build.mjs',
    'prisma/migrations/legacy/migration.sql', 'apps/web/fixture.md', 'docs/fixture.json',
    '.dockerignore', 'AGENTS.md', 'unknown.txt']) all(classifyPaths([path]));
  for (const paths of [[], null, [''], ['/tmp/a'], ['apps/web/src/../a.ts']]) all(classifyPaths(paths));
});

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'pcu-ci-git-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.email', 'ci-test@example.test');
  git('config', 'user.name', 'CI Test');
  const put = (path, content = 'fixture\n') => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  };
  const commit = () => { git('add', '-A'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  put('README.md');
  const baseSha = commit();
  const plan = (base = baseSha) => selectPlan({ eventName: 'pull_request', baseSha: base, cwd });
  return { cwd, git, put, commit, baseSha, plan };
}

test('actual Git handles spaces, newlines and more than 300 files without API truncation', t => {
  const r = repository(t);
  r.put('apps/web/src/space name.ts');
  r.put('apps/web/src/new\nline.ts');
  for (let i = 0; i < 350; i++) r.put(`docs/file-${i}.md`);
  r.commit();
  assert.deepEqual(selected(r.plan()), ['web', 'contracts', 'install']);
  // A cross-subsystem path remains visible beyond a typical API page limit.
  r.put('server/zz-last.sh'); r.commit();
  all(r.plan());
});

test('actual Git classifies both sides of rename and deleted paths', t => {
  const r = repository(t);
  r.put('apps/api/src/moved.ts'); r.put('apps/web/src/deleted.ts');
  const base = r.commit();
  mkdirSync(join(r.cwd, 'docs'), { recursive: true });
  renameSync(join(r.cwd, 'apps/api/src/moved.ts'), join(r.cwd, 'docs/moved.md'));
  rmSync(join(r.cwd, 'apps/web/src/deleted.ts')); r.commit();
  all(r.plan(base));
  // The docs destination must not hide the former API path.
  assert.equal(r.plan(base).api, true);
  assert.equal(r.plan(base).web, true);
});

test('actual merge tree includes advanced base changes conservatively', t => {
  const r = repository(t);
  r.git('checkout', '-qb', 'topic'); r.put('docs/topic.md'); r.commit();
  r.git('checkout', '-qb', 'advanced-base', r.baseSha);
  r.put('apps/api/src/base-change.ts'); r.commit();
  r.git('checkout', '-q', 'topic'); r.git('merge', '--no-edit', 'advanced-base');
  assert.equal(r.plan().api, true);
  assert.equal(r.plan().integration, true);
});

test('empty diff, invalid/missing base, absent refs and non-PR events fall back to full', t => {
  const r = repository(t);
  all(r.plan());
  for (const baseSha of [undefined, '', '--help', 'invalid', 'a'.repeat(40)]) {
    all(selectPlan({ eventName: 'pull_request', baseSha, cwd: r.cwd }));
  }
  for (const eventName of ['workflow_dispatch', 'push', undefined]) {
    all(selectPlan({ eventName, baseSha: r.baseSha, cwd: r.cwd }));
  }
});

test('errors and malformed NUL output cannot silently narrow selection', () => {
  for (const result of [{ status: 1, stdout: Buffer.alloc(0) },
    { status: 0, stdout: Buffer.from('docs/a.md') },
    { status: 0, stdout: 'docs/a.md\0' },
    { error: new Error('buffer limit'), status: null },
    { status: 0, stdout: Buffer.from('docs/a.md\0\0') }]) {
    all(selectPlan({ eventName: 'pull_request', baseSha: 'a'.repeat(40), git: () => result }));
  }
});

test('output contains every explicit boolean and a reviewable summary', t => {
  const r = repository(t);
  const outputPath = join(r.cwd, 'output');
  const summaryPath = join(r.cwd, 'summary');
  const plan = classifyPaths(['docs/a.md']);
  writePlan(plan, { outputPath, summaryPath });
  assert.equal(readFileSync(outputPath, 'utf8'), flags.map(flag => `${flag}=false\n`).join(''));
  assert.match(readFileSync(summaryPath, 'utf8'), /Documentation only/);
  assert.throws(() => writePlan({ ...plan, integration: undefined }), /Invalid CI flag/);
});

test('CLI reads the event payload and emits full flags if payload is unavailable', t => {
  const r = repository(t);
  r.put('apps/web/src/a.ts'); r.commit();
  const eventPath = join(r.cwd, 'event.json');
  const outputPath = join(r.cwd, 'output');
  writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: r.baseSha } } }));
  const script = new URL('./classify-ci-changes.mjs', import.meta.url).pathname;
  const run = () => spawnSync(process.execPath, [script], { cwd: r.cwd, encoding: 'utf8', env: {
    ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath,
    GITHUB_OUTPUT: outputPath, GITHUB_STEP_SUMMARY: '',
  } });
  assert.equal(run().status, 0);
  assert.match(readFileSync(outputPath, 'utf8'), /integration=false/);
  rmSync(outputPath); writeFileSync(eventPath, '{broken');
  assert.equal(run().status, 0);
  assert.equal(readFileSync(outputPath, 'utf8'), flags.map(flag => `${flag}=true\n`).join(''));
});
