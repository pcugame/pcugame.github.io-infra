// Real nginx auth_request/header timing and data-plane checks. Isolated Docker
// fixture only; it does not recreate or change the shared integration stack.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const work = mkdtempSync(join(tmpdir(), 'pcu-runtime-gateway-'));
const name = `pcu-runtime-gateway-${process.pid}`;
function docker(...args) {
 const result = spawnSync('docker', args, { encoding: 'utf8' });
 assert.equal(result.status, 0, result.stderr || result.stdout);
 return result.stdout.trim();
}
const policy = "default-src 'none'; script-src 'self' blob:; worker-src 'self' blob:; frame-ancestors https://api.fixture.invalid";
const fallback = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const token = 'a'.repeat(64);
const bytes = Buffer.from('0123456789abcdef');
try {
 chmodSync(work, 0o755);
 writeFileSync(join(work, 'fixture.bin'), bytes);
 writeFileSync(join(work, 'fixture.gz'), gzipSync(bytes));
 const values = {
  FILE_GATEWAY_TLS_SERVER_NAME: '', FILE_GATEWAY_API_UPSTREAM: 'http://127.0.0.1:8443',
  FILE_GATEWAY_SECRET: 'fixture-secret-at-least-32-characters',
  PUBLIC_CORS_ORIGIN_PRIMARY: 'https://web.fixture.invalid', PUBLIC_CORS_ORIGIN_SECONDARY: 'https://other.fixture.invalid',
  WEB_PUBLIC_ORIGIN: 'https://web.fixture.invalid', GARAGE_PUBLIC_WEB_UPSTREAM: 'http://127.0.0.1:8444',
  GARAGE_PUBLIC_BUCKET_HOST: 'fixture.test', GARAGE_PUBLIC_WEB_TLS_SERVER_NAME: 'fixture.test',
  GARAGE_S3_UPSTREAM: 'http://127.0.0.1:8444', GARAGE_S3_TLS_SERVER_NAME: 'fixture.test',
  S3_BUCKET_PROTECTED: 'pcu-protected', PROTECTED_DOWNLOAD_GLOBAL_CONNECTIONS: '512', PROTECTED_DOWNLOAD_PER_IP_CONNECTIONS: '128',
 };
 let config = `events {} http {
 access_log off; error_log /dev/null crit;
 map $http_x_pcu_file_uri $fixture_csp { ~missing\\.bin$ ""; default "${policy}"; }
 map $http_x_pcu_file_uri $fixture_path { ~\\.gz$ /fixture.gz; default /fixture.bin; }
 map "$http_x_pcu_file_uri:$http_x_pcu_fetch_dest" $fixture_dest_ok { ~worker\\.bin:worker$ 1; ~worker\\.bin: 0; default 1; }
 map "$http_x_pcu_file_uri:$http_x_pcu_file_method" $fixture_method_ok { ~head\\.bin:HEAD$ 1; ~head\\.bin: 0; default 1; }
 server { listen 8443;
  location / {
   if ($http_x_pcu_gateway_secret != "${values.FILE_GATEWAY_SECRET}") { return 403; }
   if ($http_cookie != "") { return 403; }
   if ($http_authorization != "") { return 403; }
   if ($http_x_pcu_file_uri ~ denied\\.bin$) { return 403; }
   if ($fixture_dest_ok = 0) { return 403; }
   if ($fixture_method_ok = 0) { return 403; }
   add_header X-PCU-Object-Path $fixture_path always;
   add_header X-PCU-Upstream-Host fixture.test always;
   add_header X-PCU-Runtime-CSP $fixture_csp always;
   return 204;
  }
 }
 server { listen 8444; root /fixture;
  if ($http_cookie != "") { return 403; }
  if ($http_authorization != "") { return 403; }
  if ($http_x_pcu_gateway_secret != "") { return 403; }
  add_header Content-Security-Policy "default-src *" always;
  add_header Service-Worker-Allowed / always;
  location / { default_type application/wasm; }
  location = /fixture.gz { default_type application/wasm; add_header Content-Encoding gzip; }
 }
`;
 for (const [index, kind] of ['public-origin', 'protected-download'].entries()) {
  let template = readFileSync(new URL(`./${kind}.nginx.conf.template`, import.meta.url), 'utf8');
  template = template.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, key) => {
   if (key === 'NGINX_LISTEN_PORT') return String(8080 + index);
   assert.ok(Object.hasOwn(values, key), `unset fixture variable ${key}`);
   return values[key];
  });
  // Production gateways have separate configurations and variable namespaces.
  if (index) template = template.replace(/\$pcu_/g, '$protected_pcu_');
  config += template.replaceAll('error_log /dev/null crit;', 'error_log stderr notice;') + '\n';
 }
 config += '}';
 writeFileSync(join(work, 'nginx.conf'), config);
 docker('run', '-d', '--name', name, '-p', '127.0.0.1::8080', '-p', '127.0.0.1::8081',
  '-v', `${work}:/fixture:ro`, '-v', `${work}/nginx.conf:/etc/nginx/nginx.conf:ro`, 'nginx:1.27-alpine');
 const validation = spawnSync('docker', ['exec', name, 'nginx', '-t'], { encoding: 'utf8' });
 if (validation.status !== 0) {
  const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8' });
  throw new Error(`nginx fixture failed: ${validation.stderr} ${logs.stderr} ${logs.stdout}`);
 }
 for (const port of [8080, 8081]) {
  const origin = 'http://' + docker('port', name, `${port}/tcp`);
  const path = `${origin}/runtime/${token}/`;
  const request = (suffix, init = {}) => fetch(path + suffix, { ...init, signal: AbortSignal.timeout(5000) });
  const response = await request('fixture.bin', { headers: { Cookie: 'sid=fixture', Authorization: 'Bearer fixture' } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), bytes.toString());
  assert.equal(response.headers.get('content-security-policy'), policy);
  assert.equal(response.headers.get('service-worker-allowed'), null);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('cross-origin-embedder-policy'), 'require-corp');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('content-type'), 'application/wasm');
  assert.ok(response.headers.get('etag'));
  assert.ok(response.headers.get('last-modified'));
  const conditional = await request('fixture.bin', { headers: { 'If-None-Match': response.headers.get('etag') } });
  assert.equal(conditional.status, 304);
  assert.equal(conditional.headers.get('content-security-policy'), policy);
  const range = await request('fixture.bin', { headers: { Range: 'bytes=0-3' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), 'bytes 0-3/16');
  assert.equal(await range.text(), '0123');
  const head = await request('head.bin', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '16');
  assert.equal(await head.text(), '');
  const compressed = await request('fixture.gz');
  assert.equal(compressed.status, 200);
  assert.equal(compressed.headers.get('content-encoding'), 'gzip');
  assert.equal(await compressed.text(), bytes.toString());
  const missing = await request('missing.bin');
  assert.equal(missing.status, 200);
  assert.equal(missing.headers.get('content-security-policy'), fallback);
  assert.equal((await request('denied.bin')).status, 403);
  for (const method of ['OPTIONS', 'POST', 'PUT', 'DELETE']) assert.equal((await request('fixture.bin', { method })).status, 405);
  assert.equal((await request('worker.bin', { headers: { 'Sec-Fetch-Dest': 'worker' } })).status, 200);
  assert.equal((await request('worker.bin')).status, 403, 'metadata must reach the auth subrequest');
  const legacy = await fetch(`${origin}/play/${token}/fixture.bin`, { signal: AbortSignal.timeout(5000) });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.headers.get('service-worker-allowed'), null, 'object metadata cannot broaden legacy SW scope');
  await legacy.arrayBuffer();
  for (const target of [`/runtime/${token}/fixture.bin`, `/play/${token}/worker.js`, '/public/webgl/1/generation/worker.js']) {
   for (const headers of [{ 'Service-Worker': 'script' }, { 'Sec-Fetch-Dest': 'serviceworker' }]) {
    assert.equal((await fetch(origin + target, { headers, signal: AbortSignal.timeout(5000) })).status, 403);
   }
  }
  assert.equal((await fetch(origin + '/runtime/short/fixture.bin', { method: 'OPTIONS' })).status, 404);
 }
 console.log('Both runtime gateways: live auth CSP, missing-policy execution denial, metadata, SW rejection, GET/HEAD, Range and compressed bytes: OK');
} finally {
 spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' });
 rmSync(work, { recursive: true, force: true });
}
