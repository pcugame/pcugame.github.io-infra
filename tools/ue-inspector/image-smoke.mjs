// Run inside the final API image as its default unprivileged user, with read-only
// root, no network, and --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createBoundedCommandRunner } from '/app/apps/api/dist/modules/process/command-runner.js';
assert.equal(process.getuid(), 1001);
const config = JSON.parse(await readFile('/opt/ue-inspector/UeInspector.runtimeconfig.json', 'utf8'));
assert.equal(config.runtimeOptions.configProperties['System.GC.HeapHardLimit'], 268435456);
const mount = Buffer.from('../../../Project/\0');
const index = Buffer.alloc(4 + mount.length + 4);
index.writeInt32LE(mount.length); mount.copy(index, 4);
const footer = Buffer.alloc(61);
footer.writeUInt32LE(0x5a6f12e1, 17); footer.writeUInt32LE(3, 21);
footer.writeBigInt64LE(BigInt(index.length), 33);
createHash('sha1').update(index).digest().copy(footer, 41);
const source = '/tmp/container', request = '/tmp/request.json';
await writeFile(source, Buffer.concat([index, footer]));
await writeFile(request, JSON.stringify({ version: 1, analysisBytes: 32 * 1024 ** 2, files: [{ path: 'Project/game.pak', localPath: source, bytes: index.length + footer.length }] }));
const runner = createBoundedCommandRunner();
const run = async () => JSON.parse((await runner.run({ file: '/opt/ue-inspector/UeInspector', args: [request], timeoutMs: 60_000, maxOutputBytes: 1024 * 1024 })).stdout);
assert.equal((await run()).facts[0].status, 'review');
index[4] ^= 1;
await writeFile(source, Buffer.concat([index, footer]));
const damaged = await run();
assert.equal(damaged.facts[0].status, 'reject');
assert.deepEqual(damaged.facts[0].reasons, ['ue-pak-index-hash-mismatch']);
console.log('Final API image: UID 1001, 256 MiB managed heap, noexec temp input, local inspector and damage verdict verified');
