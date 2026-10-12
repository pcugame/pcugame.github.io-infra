import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function fixture(name, content, extra = {}) {
 const directory = mkdtempSync(path.join(root, 'architecture-fixtures/assets-'));
 try {
  writeFileSync(path.join(directory, name), content);
  for (const [name, content] of Object.entries(extra)) writeFileSync(path.join(directory, name), content);
  return spawnSync(process.execPath, [path.join(root, 'scripts/assets-boundary-guard.mjs'), path.join(directory, name)], { encoding: 'utf8' });
 } finally { rmSync(directory, { recursive: true }); }
}
for (const [name, content, rule, extra] of [
 ['test.controller.ts', "export * from './barrel.js';", 'controller-repository', { 'barrel.ts': "export * from '../../src/modules/assets/repository.js';" }],
 ['test.service.ts', "import type { PrismaClient } from '../../src/generated/prisma/client.js';", 'service-adapter'],
 ['test.service.ts', "export * from '../../src/modules/assets/repository.js';", 'service-adapter'],
 ['test.repository.ts', "export * from '../../src/modules/assets/service.js';", 'repository-application'],
 ['test.policy.ts', "export * from './barrel.js';", 'policy-adapter', { 'barrel.ts': "export * from '../../src/modules/assets/repository.js';" }],
 ['policy.ts', "import type { FastifyInstance } from 'fastify';", 'policy-adapter'],
]) test(`${name} rejects ${rule}`, () => {
 const result = fixture(name, content, extra);
 assert.equal(result.status, 1); assert.match(result.stderr, new RegExp(rule));
});
test('real ports, policies, services and composition resolve and pass', () => {
 const result = fixture('test.composition.ts', `
 import { createAssetsBannedProductionGraph } from '../../src/modules/assets/composition.js';
 import { createAssetsService } from '../../src/modules/assets/service.js';
 import { createAssetsRepository } from '../../src/modules/assets/repository.js';
 import { createAssetDeletionUnitOfWork } from '../../src/modules/assets/deletion.repository.js';
 import type { AssetsService } from '../../src/modules/assets/ports.js';
 import { planAssetDeletion } from '../../src/modules/assets/deletion.policy.js';
 `);
 assert.equal(result.status, 0, result.stderr);
 const service = fixture('test.service.ts', "export type { AssetsService } from '../../src/modules/assets/ports.js'; export { planAssetDeletion } from '../../src/modules/assets/deletion.policy.js';");
 assert.equal(service.status, 0, service.stderr);
});
test('a misspelled allowed port target fails resolution', () => {
 const result = fixture('test.service.ts', "export type { AssetsService } from '../../src/modules/assets/nonexistent-ports.js';");
 assert.equal(result.status, 1); assert.match(result.stderr, /unresolved-import/);
});

test('a missing external dependency also fails resolution', () => {
 const result = fixture('test.service.ts', "import type { Port } from 'nonexistent-assets-port';");
 assert.equal(result.status, 1); assert.match(result.stderr, /unresolved-import/);
});
