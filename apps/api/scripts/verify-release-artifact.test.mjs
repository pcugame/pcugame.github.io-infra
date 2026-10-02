import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createArtifactPayload, verifyReleaseArtifact } from './verify-release-artifact.mjs';

const image = `ghcr.io/example/api@sha256:${'a'.repeat(64)}`;
const sourceSha = 'b'.repeat(40);
const entries = [
  'dist/server.js',
  ...['game-validation', 'webgl', 'video', 'image', 'export', 'project-publication'].map(name => `dist/${name}-worker.js`),
  'dist-release/scripts/release-migrate.js',
  'dist-release/scripts/snapshot-garage-inventory.js',
];
function write(root, path, contents = '// compiled entrypoint') {
  mkdirSync(resolve(root, path, '..'), { recursive: true });
  writeFileSync(resolve(root, path), contents);
}
function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'release-artifact-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = resolve(root, 'source');
  const packaged = resolve(root, 'image');
  const files = {
    'prisma/migrations/migration_lock.toml': 'provider = "postgresql"\n',
    'prisma/migrations/0_initial/migration.sql': 'CREATE TABLE example(id integer);\n',
    'prisma/contract-migration-paths/alternate/migration.sql': 'ALTER TABLE example ADD COLUMN name text;\n',
  };
  for (const [path, contents] of Object.entries(files)) {
    write(source, path, contents);
    write(packaged, path, contents);
  }
  for (const entry of entries) write(packaged, entry);
  return { source, packaged };
}
function executePayload(source, packaged) {
  return spawnSync(process.execPath, ['--input-type=module'], {
    cwd: packaged, input: createArtifactPayload(source), encoding: 'utf8',
  });
}
function fakeDocker(overrides = {}) {
  const calls = [];
  return { calls, run(command, args, options) {
    calls.push({ command, args, options });
    return overrides[args[0]] ?? { status: 0, stdout: args[0] === 'image' ? `${sourceSha}\n` : '', stderr: '' };
  } };
}

test('trusted checkout payload accepts the current migration inventory and all production entries', t => {
  const { source, packaged } = fixture(t);
  assert.equal(executePayload(source, packaged).status, 0);
});
test('a future source migration is accepted when packaged with matching contents', t => {
  const { source, packaged } = fixture(t);
  const path = 'prisma/migrations/20990101000000_future/migration.sql';
  write(source, path, 'SELECT 42;\n');
  write(packaged, path, 'SELECT 42;\n');
  assert.equal(executePayload(source, packaged).status, 0);
});
for (const path of ['prisma/migrations/0_initial/migration.sql', 'prisma/migrations/migration_lock.toml', 'prisma/contract-migration-paths/alternate/migration.sql']) {
  for (const mutation of ['missing', 'tampered']) {
    test(`rejects ${mutation} ${path}`, t => {
      const { source, packaged } = fixture(t);
      if (mutation === 'missing') rmSync(resolve(packaged, path));
      else write(packaged, path, 'tampered');
      const result = executePayload(source, packaged);
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(path), result.stderr);
      assert.match(result.stderr, mutation === 'missing' ? /Missing packaged migration/ : /content mismatch/);
    });
  }
}
test('rejects migrations present only in the packaged image', t => {
  const { source, packaged } = fixture(t);
  write(packaged, 'prisma/migrations/unreviewed/migration.sql', 'SELECT 1;');
  assert.match(executePayload(source, packaged).stderr, /Unexpected packaged migration file/);
});
test('rejects symlinked packaged SQL even when its contents match', t => {
  const { source, packaged } = fixture(t);
  const path = 'prisma/migrations/0_initial/migration.sql';
  rmSync(resolve(packaged, path));
  symlinkSync(resolve(source, path), resolve(packaged, path));
  assert.match(executePayload(source, packaged).stderr, /must be a regular file or directory/);
});
for (const entry of entries) {
  test(`rejects missing production entry ${entry}`, t => {
    const { source, packaged } = fixture(t);
    rmSync(resolve(packaged, entry));
    assert.match(executePayload(source, packaged).stderr, /Missing production entrypoint/);
  });
}
test('rejects a legacy Phase 1 artifact', t => {
  const { source, packaged } = fixture(t);
  write(packaged, 'dist/phase1-release-manifest.js');
  assert.match(executePayload(source, packaged).stderr, /Phase 1 runtime/);
});
test('validates digest and source SHA before invoking Docker', () => {
  for (const invalidImage of [undefined, '', 'ghcr.io/example/api:latest', image.replace('sha256:', 'sha512:'), image.slice(0, -1), `${image}\n`, '--help']) {
    const docker = fakeDocker();
    assert.throws(() => verifyReleaseArtifact({ image: invalidImage, sourceSha, run: docker.run }), /RELEASE_IMAGE/);
    assert.equal(docker.calls.length, 0);
  }
  for (const invalidSha of [undefined, '', 'b'.repeat(39), 'B'.repeat(40), `${sourceSha}\n`, 'z'.repeat(40)]) {
    const docker = fakeDocker();
    assert.throws(() => verifyReleaseArtifact({ image, sourceSha: invalidSha, run: docker.run }), /RELEASE_SOURCE_SHA/);
    assert.equal(docker.calls.length, 0);
  }
});
test('pulls and inspects the exact digest before running trusted payload', t => {
  const { source, packaged } = fixture(t);
  const docker = fakeDocker();
  verifyReleaseArtifact({ image, sourceSha, root: source, run: docker.run });
  assert.deepEqual(docker.calls.map(call => call.args[0]), ['pull', 'image', 'run']);
  assert.ok(docker.calls.every(call => call.command === 'docker' && call.args.includes(image)));
  assert.deepEqual(docker.calls[2].args, ['run', '--rm', '-i', '--workdir', '/app/apps/api', '--entrypoint', 'node', image, '--input-type=module']);
  assert.equal(docker.calls[2].options.input, createArtifactPayload(source));
  const payloadResult = spawnSync(process.execPath, ['--input-type=module'], {
    cwd: packaged, input: docker.calls[2].options.input, encoding: 'utf8',
  });
  assert.equal(payloadResult.status, 0, payloadResult.stderr);
});
for (const revision of ['', 'c'.repeat(40), '<no value>']) {
  test(`OCI revision ${revision || '<empty>'} mismatch stops before running the image`, t => {
    const { source } = fixture(t);
    const docker = fakeDocker({ image: { status: 0, stdout: revision, stderr: '' } });
    assert.throws(() => verifyReleaseArtifact({ image, sourceSha, root: source, run: docker.run }), /OCI revision mismatch/);
    assert.deepEqual(docker.calls.map(call => call.args[0]), ['pull', 'image']);
  });
}
for (const stage of ['pull', 'image', 'run']) {
  test(`propagates Docker ${stage} failures and stops`, t => {
    const { source } = fixture(t);
    const docker = fakeDocker({ [stage]: { status: 17, stdout: '', stderr: 'docker failure diagnostic' } });
    assert.throws(() => verifyReleaseArtifact({ image, sourceSha, root: source, run: docker.run }), /failed \(17\): docker failure diagnostic/);
    assert.equal(docker.calls.at(-1).args[0], stage);
  });
}
test('propagates Docker executable errors', t => {
  const { source } = fixture(t);
  const docker = fakeDocker({ pull: { status: null, error: new Error('spawn docker ENOENT') } });
  assert.throws(() => verifyReleaseArtifact({ image, sourceSha, root: source, run: docker.run }), /spawn docker ENOENT/);
});
test('CLI rejects missing environment identity without needing Docker', () => {
  const result = spawnSync(process.execPath, [new URL('./verify-release-artifact.mjs', import.meta.url).pathname], {
    env: { PATH: '', RELEASE_IMAGE: '', RELEASE_SOURCE_SHA: '' }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RELEASE_IMAGE/);
});
test('workflow calls the verifier with immutable identity before manifest publication', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/deploy-api.yml', import.meta.url), 'utf8');
  const verifyStep = workflow.slice(workflow.indexOf('      - name: Verify immutable release artifact'), workflow.indexOf('      - name: Record immutable release digest'));
  assert.match(verifyStep, /RELEASE_IMAGE: .*@\$\{\{ steps\.release-image\.outputs\.digest \}\}/);
  assert.match(verifyStep, /RELEASE_SOURCE_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(verifyStep, /run: node apps\/api\/scripts\/verify-release-artifact\.mjs/);
  assert.ok(!verifyStep.includes('docker '));
  assert.ok(workflow.indexOf('run: node apps/api/scripts/verify-release-artifact.mjs') < workflow.indexOf('Publish verified release manifest'));
  assert.ok(!/202\d{11}_/.test(verifyStep));
});
