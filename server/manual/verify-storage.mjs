// Disposable Garage + trusted TLS fixture for the manual initialization contract.
// No production settings or service are modified.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const name = `pcu-manual-storage-${process.pid}`;
const work = mkdtempSync(join(tmpdir(), name));
const image = file => readFileSync(new URL(file, import.meta.url), 'utf8').match(/^Image=(.+)$/m)[1];
const apiImage = process.env.MANUAL_API_IMAGE || 'pcu-manual-api:verify';
function run(cmd, args, input) {
  const result = spawnSync(cmd, args, { input, encoding: 'utf8', timeout: 60_000 });
  // Do not echo output from key generation or secret-bearing env files.
  assert.equal(result.status, 0, `${cmd} failed: ${result.stderr}`);
  return result.stdout.trim();
}
const docker = (...args) => run('docker', args);
const garage = (...args) => docker('exec', `${name}-garage`, '/garage', ...args);
const sdk = code => run('docker', ['run', '--rm', '-i', '--network', name, '--env-file', join(work, 'app.env'),
  '-v', `${work}/fullchain.pem:/etc/pcu/ca.crt:ro`, '--entrypoint', 'node', apiImage, '--input-type=module'], code);
const sdkPrelude = `import assert from 'node:assert/strict';
import { S3Client, PutBucketCorsCommand, GetBucketCorsCommand, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
const s3 = new S3Client({ endpoint: 'https://s3.internal.pcu.test', region: 'garage', forcePathStyle: true,
 credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } });\n`;
try {
  chmodSync(work, 0o755);
  docker('network', 'create', '--internal', name);
  for (const suffix of ['data', 'meta']) docker('volume', 'create', `${name}-${suffix}`);
  writeFileSync(join(work, 'garage.toml'), readFileSync(new URL('./config/garage.toml.example', import.meta.url), 'utf8')
    .replace('REPLACE_WITH_64_HEX_CHARACTERS', randomBytes(32).toString('hex'))
    .replace('REPLACE_WITH_SEPARATE_GARAGE_ADMIN_TOKEN', randomBytes(32).toString('hex')), { mode: 0o600 });
  docker('run', '-d', '--name', `${name}-garage`, '--network', name, '--network-alias', 'garage',
    '-v', `${work}/garage.toml:/etc/garage.toml:ro`, '-v', `${name}-data:/var/lib/garage/data`, '-v', `${name}-meta:/var/lib/garage/meta`, image('./rootless/pcu-garage.container'));
  let status = '';
  for (let i = 0; i < 40; i++) {
    const result = spawnSync('docker', ['exec', `${name}-garage`, '/garage', 'status'], { encoding: 'utf8' });
    if (result.status === 0) { status = result.stdout; break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const node = status.match(/^([a-f0-9]+)\s/m)?.[1]; assert.ok(node);
  garage('layout', 'assign', node, '-z', 'single-pc', '-c', '1G');
  garage('layout', 'apply', '--version', '1');
  for (const bucket of ['pcu-public', 'pcu-protected']) garage('bucket', 'create', bucket);
  garage('bucket', 'website', '--allow', 'pcu-public');
  const key = garage('key', 'create', 'pcu-app');
  const id = key.match(/^Key ID: (.+)$/m)?.[1], secret = key.match(/^Secret key: (.+)$/m)?.[1]; assert.ok(id && secret);
  writeFileSync(join(work, 'app.env'), `NODE_EXTRA_CA_CERTS=/etc/pcu/ca.crt\nS3_ACCESS_KEY_ID=${id}\nS3_SECRET_ACCESS_KEY=${secret}\n`, { mode: 0o600 });
  for (const bucket of ['pcu-public', 'pcu-protected']) garage('bucket', 'allow', bucket, '--read', '--write', '--owner', '--key', 'pcu-app');
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=s3.internal.pcu.test', '-addext', 'subjectAltName=DNS:s3.internal.pcu.test', '-keyout', join(work, 'privkey.pem'), '-out', join(work, 'fullchain.pem')]);
  // Only adapt the fixed production address to this disposable Docker network's DNS.
  writeFileSync(join(work, 's3-tls.conf'), readFileSync(new URL('./config/s3-tls.conf', import.meta.url), 'utf8').replace('10.89.41.10', 'garage'));
  docker('run', '-d', '--name', `${name}-tls`, '--network', name, '--network-alias', 's3.internal.pcu.test',
    '-v', `${work}/s3-tls.conf:/etc/nginx/conf.d/default.conf:ro`, '-v', `${work}:/etc/pcu/tls:ro`, image('./rootless/pcu-s3-tls.container'));
  for (const kind of ['public', 'protected']) {
    const policy = JSON.parse(readFileSync(new URL(`./config/cors-${kind}.json`, import.meta.url)));
    sdk(sdkPrelude + `const Bucket = 'pcu-${kind}', CORSConfiguration = ${JSON.stringify(policy)};
await s3.send(new PutBucketCorsCommand({Bucket,CORSConfiguration}));
assert.deepEqual((await s3.send(new GetBucketCorsCommand({Bucket}))).CORSRules,CORSConfiguration.CORSRules); s3.destroy();`);
  }
  for (const bucket of ['pcu-public', 'pcu-protected']) garage('bucket', 'deny', bucket, '--owner', '--key', 'pcu-app');
  sdk(sdkPrelude + `await s3.send(new PutObjectCommand({Bucket:'pcu-protected',Key:'fixture.bin',Body:'0123456789'}));
const result=await s3.send(new GetObjectCommand({Bucket:'pcu-protected',Key:'fixture.bin',Range:'bytes=2-5'}));
assert.equal(await result.Body.transformToString(),'2345');
assert.equal((await fetch('https://s3.internal.pcu.test/pcu-protected/fixture.bin')).status,403); s3.destroy();`);
  docker('restart', `${name}-garage`);
  garage('status');
  sdk(sdkPrelude + `const result=await s3.send(new GetObjectCommand({Bucket:'pcu-protected',Key:'fixture.bin'}));
assert.equal(await result.Body.transformToString(),'0123456789'); s3.destroy();`);
  assert.equal(docker('port', `${name}-garage`), '');
  console.log('PASS: Garage layout/buckets/key, exact-origin CORS through verified TLS, owner revocation retaining read/write, Range bytes, object persistence after restart, no host publication.');
} finally {
  for (const suffix of ['tls', 'garage']) spawnSync('docker', ['rm', '-f', `${name}-${suffix}`]);
  for (const suffix of ['data', 'meta']) spawnSync('docker', ['volume', 'rm', `${name}-${suffix}`]);
  spawnSync('docker', ['network', 'rm', name]);
  rmSync(work, { recursive: true, force: true });
}
