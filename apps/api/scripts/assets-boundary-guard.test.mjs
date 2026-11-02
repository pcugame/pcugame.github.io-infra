import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const workspace = path.resolve(root, '../..');
const boundary = path.join(root, 'scripts/assets-boundary-guard.mjs');
function run(script, targets = [], cwd = root) {
 return spawnSync(process.execPath, [script, ...targets], { cwd, encoding: 'utf8' });
}
function fixture(t, name, content, extra = {}) {
 const directory = mkdtempSync(path.join(root, 'architecture-fixtures/scoped-'));
 t.after(() => rmSync(directory, { recursive: true, force: true }));
 for (const [file, source] of Object.entries({ [name]: content, ...extra })) {
  const target = path.join(directory, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, source);
 }
 return path.join(directory, name);
}
function forbidden(result, rule) {
 assert.equal(result.status, 1, result.stderr);
 assert.match(result.stderr, new RegExp(`\\[assets-boundary\\] ${rule} `));
 assert.doesNotMatch(result.stderr, /unresolved-|parse-error/);
}

// PR #113's four layer rules, with resolvable negative graphs. Include barrels,
// import/export type syntax, renamed bindings, and literal dynamic imports.
for (const [name, content, rule, extra] of [
 ['test.controller.ts', "export * from './barrel.js';", 'controller-repository',
  { 'barrel.ts': "export * from './test.repository.js';", 'test.repository.ts': 'export const repository = {};' }],
 ['test.controller.ts', "import type { Repository as Port } from './barrel.js';", 'controller-repository',
  { 'barrel.ts': "export type { Repository } from './test.repository.js';", 'test.repository.ts': 'export interface Repository {}' }],
 ['test.service.ts', "import type { PrismaClient } from '../../src/generated/prisma/client.js';", 'service-adapter'],
 ['test.service.ts', "export type { PrismaClient as Port } from '../../src/generated/prisma/client.js';", 'service-adapter'],
 ['test.service.ts', "export * from './test.repository.js';", 'service-adapter', { 'test.repository.ts': 'export const repository = {};' }],
 ['test.service.ts', "export const load = () => import('./test.repository.js');", 'service-adapter', { 'test.repository.ts': 'export const repository = {};' }],
 ['test.service.ts', "export type Port = import('./test.repository.js').Repository;", 'service-adapter', { 'test.repository.ts': 'export interface Repository {}' }],
 ['test.repository.ts', "export * from './test.service.js';", 'repository-application', { 'test.service.ts': 'export const service = {};' }],
 ['test.policy.ts', "export * from './barrel.js';", 'policy-adapter',
  { 'barrel.ts': "export type { Repository } from './test.repository.js';", 'test.repository.ts': 'export interface Repository {}' }],
 ['policy.ts', "import type { FastifyInstance } from 'fastify';", 'policy-adapter'],
]) test(`${name} rejects ${rule}: ${content}`, t => forbidden(run(boundary, [fixture(t, name, content, extra)]), rule));

test('real ports, policies, factories and composition resolve and pass', t => {
 const entry = fixture(t, 'test.composition.ts', `
 import { createAssetsBannedProductionGraph } from '../../src/modules/assets/composition.js';
 import { createAssetsRepository } from '../../src/modules/assets/repository.js';
 import type { ObjectStorage } from '../../src/application/ports.js';
 import { authorizeAssetDelivery } from '../../src/modules/assets/delivery-policy.js';
 `);
 const result = run(boundary, [entry]);
 assert.equal(result.status, 0, result.stderr);
 const service = fixture(t, 'test.service.ts', `
 export type { ObjectStorage } from '../../src/application/ports.js';
 export { authorizeAssetDelivery } from '../../src/modules/assets/delivery-policy.js';
 `);
 assert.equal(run(boundary, [service]).status, 0);
});

test('scoped traversal terminates on port barrel cycles; dependency-cruiser owns cycle prohibition', t => {
 const entry = fixture(t, 'test.service.ts', "import type { Port } from './a.js';", {
  'a.ts': "export type { Port } from './b.js';",
  'b.ts': "export type { Port as Other } from './a.js'; export interface Port {}",
 });
 const result = run(boundary, [entry]);
 assert.equal(result.status, 0, result.stderr);
});

for (const source of [
 "export type { Port } from './nonexistent-ports.js';",
 "import type { Port } from 'nonexistent-assets-port';",
]) test(`unresolved allowed import fails: ${source}`, t => {
 const result = run(boundary, [fixture(t, 'test.service.ts', source)]);
 assert.equal(result.status, 1);
 assert.match(result.stderr, /unresolved-import/);
 assert.doesNotMatch(result.stderr, /service-adapter/);
});

test('missing root, empty directory and malformed source fail closed', t => {
 const entry = fixture(t, 'test.service.ts', 'export const broken = ;');
 const malformed = run(boundary, [entry]);
 assert.equal(malformed.status, 1);
 assert.match(malformed.stderr, /parse-error/);
 const missing = run(boundary, [entry + '.missing']);
 assert.equal(missing.status, 1);
 assert.match(missing.stderr, /unresolved-root/);
 const empty = path.join(path.dirname(entry), 'empty');
 mkdirSync(empty);
 const result = run(boundary, [empty]);
 assert.equal(result.status, 1);
 assert.match(result.stderr, /empty-scope/);
});

for (const [source, status] of [
 ["export { type Marker } from './video-worker.js';", 0],
 ["export { type Marker, run } from './video-worker.js';", 1],
 ["export const load = () => import('./video-worker.js');", 1],
]) test(`data-plane preserves runtime/type-only distinction: ${source}`, t => {
 const entry = fixture(t, 'test.controller.ts', source, {
  'video-worker.ts': 'export interface Marker {} export function run() {}',
 });
 const result = run(path.join(root, 'scripts/architecture-guard.mjs'), [path.dirname(entry)]);
 assert.equal(result.status, status, result.stderr);
 if (status) assert.match(result.stderr, /\[architecture-guard\] no-api-worker-import /);
});

function replica(t) {
 const directory = mkdtempSync(path.join(os.tmpdir(), 'architecture-entrypoint-'));
 t.after(() => rmSync(directory, { recursive: true, force: true }));
 const api = path.join(directory, 'apps/api');
 mkdirSync(path.join(api, 'scripts'), { recursive: true });
 symlinkSync(path.join(workspace, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
 if (existsSync(path.join(root, 'node_modules'))) symlinkSync(path.join(root, 'node_modules'), path.join(api, 'node_modules'), 'dir');
 symlinkSync(path.join(root, 'src'), path.join(api, 'src'), 'dir');
 for (const file of ['architecture-guard.mjs', 'architecture-self-test.mjs', 'assets-boundary-guard.mjs']) {
  cpSync(path.join(root, 'scripts', file), path.join(api, 'scripts', file));
 }
 cpSync(path.join(root, 'architecture-fixtures/forbidden'), path.join(api, 'architecture-fixtures/forbidden'), { recursive: true });
 cpSync(path.join(root, 'architecture-fixtures/allowed'), path.join(api, 'architecture-fixtures/allowed'), { recursive: true });
 cpSync(path.join(root, 'architecture-fixtures/data-plane'), path.join(api, 'architecture-fixtures/data-plane'), { recursive: true });
 cpSync(path.join(root, '.dependency-cruiser.cjs'), path.join(api, '.dependency-cruiser.cjs'));
 cpSync(path.join(root, 'tsconfig.json'), path.join(api, 'tsconfig.json'));
 return api;
}

test('self-test rejects an omitted ownership case before executing guards', t => {
 const api = replica(t), script = path.join(api, 'scripts/architecture-self-test.mjs');
 writeFileSync(script, readFileSync(script, 'utf8').replace(
  "\t['controller-env', 'controller.ts', 'no-controller-env'],", ''));
 const result = run(script, [], api);
 assert.equal(result.status, 1);
 assert.match(result.stderr, /fixture-inventory/);
});

test('self-test rejects an omitted data-plane case', t => {
 const api = replica(t), script = path.join(api, 'scripts/architecture-self-test.mjs');
 writeFileSync(script, readFileSync(script, 'utf8').replace(
  "\t['API object read', 'api-object-read', 'no-api-object-body-read'],", ''));
 const result = run(script, [], api);
 assert.equal(result.status, 1);
 assert.match(result.stderr, /fixture-inventory data-plane/);
});

test('self-test actually exercises the ownership and data-plane rules from its inventory', t => {
 const api = replica(t), guard = path.join(api, 'scripts/architecture-guard.mjs');
 writeFileSync(guard, readFileSync(guard, 'utf8')
  .replaceAll("'no-controller-env'", "'disabled-controller-env'")
  .replaceAll("'no-api-object-body-read'", "'disabled-object-body-read'"));
 const result = run(path.join(api, 'scripts/architecture-self-test.mjs'), [], api);
 assert.equal(result.status, 1);
 assert.match(result.stderr, /FAIL ownership .*controller-env/);
 assert.match(result.stderr, /FAIL guard API object read/);
});

test('self-test rejects a positive fixture whose real port import was removed', t => {
 const api = replica(t);
 writeFileSync(path.join(api, 'architecture-fixtures/allowed/controller.ts'), 'export const controller = {};');
 const result = run(path.join(api, 'scripts/architecture-self-test.mjs'), [], api);
 assert.equal(result.status, 1);
 assert.match(result.stderr, /allowed-edge-mismatch/);
});

test('a matching forbidden rule plus unresolved import is still a self-test failure', t => {
 const api = replica(t);
 writeFileSync(path.join(api, 'architecture-fixtures/forbidden/controller-env/controller.ts'),
  "import { loadEnv } from './missing/src/config/env.js'; export const config = loadEnv;");
 const result = run(path.join(api, 'scripts/architecture-self-test.mjs'), [], api);
 assert.equal(result.status, 1);
 assert.match(result.stderr, /expected=no-controller-env/);
 assert.match(result.stderr, /unresolved-import/);
});

test('npm entrypoints retain both guards, both fixture suites and dependency-cruiser', () => {
 const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
 assert.equal(scripts['architecture:guard'], 'node scripts/architecture-guard.mjs src scripts && node scripts/assets-boundary-guard.mjs');
 assert.equal(scripts['architecture:self-test'], 'node scripts/architecture-self-test.mjs && node --test scripts/assets-boundary-guard.test.mjs');
 assert.equal(scripts.architecture, 'npm run architecture:guard && npm run architecture:self-test && depcruise --config .dependency-cruiser.cjs src scripts');
 assert.equal(JSON.parse(readFileSync(path.join(workspace, 'package.json'), 'utf8')).scripts.architecture, 'npm run architecture -w apps/api');
});

test('default strict production roots receive the same rules as fixture roots', t => {
 const api = replica(t);
 // Replace the symlink itself, never a file in the user's source tree.
 rmSync(path.join(api, 'src'));
 cpSync(path.join(root, 'src'), path.join(api, 'src'), { recursive: true });
 const script = path.join(api, 'scripts/assets-boundary-guard.mjs');
 const baseline = run(script, [], api);
 assert.equal(baseline.status, 0, baseline.stderr);
 assert.match(baseline.stdout, /roots=7 /);
 for (const [file, rule] of [
  ['modules/assets/delivery-policy.ts', 'policy-adapter'],
  ['modules/admin/project/project-status.service.ts', 'service-adapter'],
  ['modules/admin/project/update.service.ts', 'service-adapter'],
  ['modules/admin/project/update.policy.ts', 'policy-adapter'],
  ['modules/admin/project-access.policy.ts', 'policy-adapter'],
 ]) {
  const target = path.join(api, 'src', file), original = readFileSync(target, 'utf8');
  writeFileSync(target, original + "\nimport type { FastifyInstance } from 'fastify';\n");
  forbidden(run(script, [], api), rule);
  writeFileSync(target, original);
 }
 for (const [file, source, rule] of [
  ['modules/admin/project/update.controller.ts', "import type { createProjectUpdateRepository } from './update.repository.js';", 'controller-repository'],
  ['modules/admin/project/update.repository.ts', "import type { updateProject } from './update.service.js';", 'repository-application'],
 ]) {
  const target = path.join(api, 'src', file), original = readFileSync(target, 'utf8');
  writeFileSync(target, original + '\n' + source);
  forbidden(run(script, [], api), rule);
  writeFileSync(target, original);
 }
});
