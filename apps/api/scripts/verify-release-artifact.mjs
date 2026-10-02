import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, lstatSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const migrationRoots = ['prisma/migrations', 'prisma/contract-migration-paths'];
const apiRoot = fileURLToPath(new URL('../', import.meta.url));
const productionEntries = [
  'dist/server.js',
  ...['game-validation', 'webgl', 'video', 'image', 'export', 'project-publication']
    .map(worker => `dist/${worker}-worker.js`),
  ...['release-migrate', 'snapshot-garage-inventory']
    .map(cli => `dist-release/scripts/${cli}.js`),
];

export function validateReleaseIdentity(image, sourceSha) {
  if (typeof image !== 'string' || !/^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(image)) {
    throw new Error('RELEASE_IMAGE must be an immutable image reference ending in @sha256:<64 lowercase hex characters>');
  }
  if (typeof sourceSha !== 'string' || !/^[a-f0-9]{40}$/.test(sourceSha)) {
    throw new Error('RELEASE_SOURCE_SHA must be a full 40-character lowercase Git SHA');
  }
}

// This function is also sent from the trusted checkout to Node inside the image.
// Keep it self-contained apart from the explicitly imported Node builtins.
export function migrationInventory(root, roots) {
  const inventory = {};
  function visit(relative) {
    const path = resolve(root, relative);
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(`${relative}/${name}`);
    } else if (stat.isFile()) {
      inventory[relative] = createHash('sha256').update(readFileSync(path)).digest('hex');
    } else {
      throw new Error(`Migration artifact must be a regular file or directory: ${relative}`);
    }
  }
  for (const relative of roots) visit(relative);
  return inventory;
}

export function verifyPackagedArtifact(root, expected, roots, entries) {
  if (existsSync(resolve(root, 'dist/phase1-release-manifest.js'))) {
    throw new Error('Phase 1 runtime is not a production release artifact');
  }
  for (const entry of entries) {
    if (!existsSync(resolve(root, entry)) || !lstatSync(resolve(root, entry)).isFile()) {
      throw new Error(`Missing production entrypoint: ${entry}`);
    }
  }
  const actual = migrationInventory(root, roots);
  for (const path of Object.keys(expected)) {
    if (!(path in actual)) throw new Error(`Missing packaged migration file: ${path}`);
    if (actual[path] !== expected[path]) throw new Error(`Packaged migration content mismatch: ${path}`);
  }
  for (const path of Object.keys(actual)) {
    if (!(path in expected)) throw new Error(`Unexpected packaged migration file: ${path}`);
  }
}

export function createArtifactPayload(root = apiRoot) {
  const expected = migrationInventory(root, migrationRoots);
  return `import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, lstatSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
${migrationInventory.toString()}
${verifyPackagedArtifact.toString()}
verifyPackagedArtifact(process.cwd(), ${JSON.stringify(expected)}, ${JSON.stringify(migrationRoots)}, ${JSON.stringify(productionEntries)});
`;
}

export function verifyReleaseArtifact({ image, sourceSha, root = apiRoot, run = spawnSync }) {
  validateReleaseIdentity(image, sourceSha);
  const payload = createArtifactPayload(root);
  function docker(args, options = {}) {
    const result = run('docker', args, { encoding: 'utf8', ...options });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`docker ${args[0]} failed (${result.status ?? result.signal ?? 'unknown'}): ${result.stderr?.trim() || 'no diagnostic output'}`);
    }
    return result.stdout;
  }
  docker(['pull', image]);
  const revision = docker(['image', 'inspect', image, '--format', '{{ index .Config.Labels "org.opencontainers.image.revision" }}']).trim();
  if (revision !== sourceSha) throw new Error(`Image OCI revision mismatch: expected ${sourceSha}, received ${revision || '<missing>'}`);
  docker(['run', '--rm', '-i', '--workdir', '/app/apps/api', '--entrypoint', 'node', image, '--input-type=module'], { input: payload });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    verifyReleaseArtifact({ image: process.env.RELEASE_IMAGE, sourceSha: process.env.RELEASE_SOURCE_SHA });
    console.log('Verified immutable API release artifact and source migration inventory.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
