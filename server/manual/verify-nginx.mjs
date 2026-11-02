// Run the provided static configs and read-only gateway mounts in real Nginx.
// This verifies configuration/mount/TLS mechanics, not Podman networking.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = resolve(new URL('../..', import.meta.url).pathname);
const work = mkdtempSync(join(tmpdir(), 'pcu-manual-nginx-'));
const names = [];
const nginx = readFileSync(new URL('./rootful/pcu-edge.container', import.meta.url), 'utf8').match(/^Image=(.+)$/m)[1];
const run = (cmd, args) => {
  const result = spawnSync(cmd, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
};
const docker = (...args) => run('docker', args);
try {
  chmodSync(work, 0o755);
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=manual-test', '-addext', 'subjectAltName=DNS:api.pcu.test,DNS:s3.internal.pcu.test', '-keyout', join(work, 'privkey.pem'), '-out', join(work, 'fullchain.pem')]);
  writeFileSync(join(work, 'gateway.env'), readFileSync(new URL('./config/gateway.env.example', import.meta.url)), { mode: 0o600 });
  for (const [index, template] of ['upload-part', 'public-origin', 'protected-download'].entries()) {
    const name = `pcu-manual-nginx-${process.pid}-${index}`; names.push(name);
    docker('run', '-d', '--name', name, '--read-only', '--security-opt', 'no-new-privileges',
      '--tmpfs', '/etc/nginx/conf.d:rw,noexec,nosuid,size=1m', '--tmpfs', '/var/cache/nginx:rw,noexec,nosuid,size=32m',
      '--tmpfs', '/var/log/nginx:rw,noexec,nosuid,size=16m', '--tmpfs', '/var/run:rw,noexec,nosuid,size=16m', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
      '--env-file', join(work, 'gateway.env'), '-p', '127.0.0.1::8080',
      '-v', `${root}/apps/db/${template}.nginx.conf.template:/etc/nginx/templates/default.conf.template:ro`,
      '-v', `${root}/apps/db/validate-data-plane-env.sh:/docker-entrypoint.d/05-validate-data-plane-env.sh:ro`,
      '-v', `${root}/server/manual/config/gateway-realip.conf:/etc/nginx/conf.d/realip.conf:ro`,
      '-v', `${work}/fullchain.pem:/etc/ssl/certs/ca-certificates.crt:ro`, nginx);
    docker('exec', name, 'nginx', '-t');
    const health = ['upload', 'public', 'protected_download'][index];
    const response = await fetch(`http://${docker('port', name, '8080/tcp')}/__pcu_${health}_health`);
    assert.equal(response.status, 204);
    assert.equal(docker('exec', name, 'cat', '/etc/nginx/conf.d/default.conf').includes('${'), false, 'all environment placeholders rendered');
  }
  for (const [index, config] of ['tls-proxy', 's3-tls'].entries()) {
    const name = `pcu-manual-nginx-${process.pid}-tls-${index}`; names.push(name);
    docker('run', '-d', '--name', name, '-p', '127.0.0.1::443', '-v', `${root}/server/manual/config/${config}.conf:/etc/nginx/conf.d/default.conf:ro`, '-v', `${work}:/etc/pcu/tls:ro`, nginx);
    docker('exec', name, 'nginx', '-t');
    const port = docker('port', name, '443/tcp').split(':').at(-1);
    const host = index ? 's3.internal.pcu.test' : 'api.pcu.test';
    // No backend is running here; 502/504 establishes a verified TLS connection
    // without pretending to prove the real rootless upstream path.
    assert.ok(['502', '504'].includes(run('curl', ['--max-time', '15', '--noproxy', '*', '-sS', '--cacert', join(work, 'fullchain.pem'), '--resolve', `${host}:${port}:127.0.0.1`, '-o', '/dev/null', '-w', '%{http_code}', `https://${host}:${port}/`])));
  }
  console.log('PASS: three read-only gateway mounts/env substitution/health and both TLS Nginx configs with certificate verification. Backend connectivity is not covered.');
} finally {
  for (const name of names) spawnSync('docker', ['rm', '-f', name]);
  rmSync(work, { recursive: true, force: true });
}
