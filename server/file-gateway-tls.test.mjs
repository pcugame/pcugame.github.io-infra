import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import https from 'node:https';
import Fastify from 'fastify';
import { createDiagnosticController } from '../apps/api/src/modules/webgl-play/diagnostic-controller.ts';
import { createDiagnosticService } from '../apps/api/src/modules/webgl-play/diagnostic-service.ts';
import { forbidden } from '../apps/api/src/shared/errors.ts';

const { ROOT: root, WORK: work, NAME: name } = process.env;
const token = 'a'.repeat(64), invalidToken = 'b'.repeat(64);
const reportPath = `/api/webgl-play/reports/${token}`;
const body = JSON.stringify({ 'csp-report': {
 'blocked-uri': 'https://user:payload-secret@blocked.example.com/private?key=payload-secret',
 'effective-directive': 'connect-src', 'script-sample': 'payload-secret',
} });
const records = [], requests = [];
let apiLogs = '';
const api = Fastify({ logger: { level: 'trace', stream: { write: line => { apiLogs += line; } } } });
api.addHook('onRequest', async request => {
 requests.push({ method: request.method, url: request.url, headers: request.headers });
});
api.addHook('onSend', async (_request, reply) => { reply.header('Set-Cookie', 'must-not-leak=1'); });
await api.register(createDiagnosticController(createDiagnosticService({
 async record(hash, item) {
  if (hash !== createHash('sha256').update(token).digest('hex')) throw forbidden();
  records.push(item);
 },
 async list() { return []; },
})));
api.get('/api/internal/file-access', async (request, reply) => {
 assert.equal(request.headers.cookie, undefined);
 assert.equal(request.headers.authorization, undefined);
 assert.equal(request.headers['x-pcu-gateway-secret'], 'fixture-secret-at-least-32-characters');
 reply.header('X-PCU-Object-Path', '/fixture.bin').header('X-PCU-Upstream-Host', 'fixture.test').code(204).send();
});
const docker = (...args) => {
 const result = spawnSync('docker', args, { encoding: 'utf8' });
 assert.equal(result.status, 0, result.stderr || result.stdout);
 return (args[0] === 'logs' ? result.stdout + result.stderr : result.stdout).trim();
};
async function freePort() {
 const server = createServer();
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 const port = server.address().port;
 await new Promise(resolve => server.close(resolve));
 return port;
}
const request = (port, path, method = 'POST', payload = body, tls = false, localAddress = '127.0.0.1') => {
 const options = { method, headers: { 'Content-Type': 'application/csp-report', Cookie: 'sid=credential-secret', Authorization: 'Bearer credential-secret' } };
 if (!tls) return fetch(`http://127.0.0.1:${port}${path}`, { ...options,
  body: ['GET', 'HEAD'].includes(method) ? undefined : payload, signal: AbortSignal.timeout(5000) });
 return new Promise((resolve, reject) => {
  const req = https.request({ ...options, hostname: '127.0.0.1', port, path,
   localAddress, servername: 'pcu-file-auth.internal', ca: readFileSync(`${work}/identity/trust.pem`), timeout: 5000 }, res => {
   res.resume(); res.on('end', () => resolve({ status: res.statusCode, headers: { get: key => res.headers[key] ?? null } }));
  });
  req.on('error', reject); req.on('timeout', () => req.destroy(new Error('TLS request timeout')));
  req.end(['GET', 'HEAD'].includes(method) ? undefined : payload);
 });
};
try {
 await api.listen({ host: '127.0.0.1', port: 0 });
 const apiPort = api.server.address().port;
 const tlsPort = await freePort(), wrongPort = await freePort(), objectPort = await freePort();
 let config = 'events {} http { access_log off; error_log /dev/null crit;\n';
 const generated = readFileSync(`${work}/identity/zz-pcu-file-auth`, 'utf8');
 // Change only fixture addresses and certificate paths; preserve every location,
 // allowlist, method restriction, proxy header, body limit and logging directive.
 const vhost = generated.replace('listen 443 ssl;', `listen 127.0.0.1:${tlsPort} ssl;`)
  .replace('listen [::]:443 ssl;', '')
  .replaceAll(`${work}/identity/`, '/fixture/identity/')
  .replaceAll('http://127.0.0.1:4000', `http://127.0.0.1:${apiPort}`);
 config += vhost;
 config += vhost.replace(`:${tlsPort} ssl`, `:${wrongPort} ssl`)
  .replace('/fixture/identity/trust.pem', '/fixture/wrong.pem').replace('/fixture/identity/server.key', '/fixture/wrong.key');
 config += `server { listen 127.0.0.1:${objectPort}; root /fixture; }\n`;
 writeFileSync(`${work}/fixture.bin`, 'authorized');
 const gateways = [];
 for (const kind of ['public-origin', 'protected-download']) {
  for (const [upstream, tlsName] of [[tlsPort, 'pcu-file-auth.internal'], [tlsPort, 'wrong.internal'], [wrongPort, 'pcu-file-auth.internal']]) {
   const port = await freePort();
   const values = {
    NGINX_RESOLVER: '127.0.0.11', NGINX_LISTEN_PORT: `127.0.0.1:${port}`, FILE_GATEWAY_TLS_SERVER_NAME: tlsName,
    FILE_GATEWAY_API_UPSTREAM: `https://127.0.0.1:${upstream}`, FILE_GATEWAY_SECRET: 'fixture-secret-at-least-32-characters',
    PUBLIC_CORS_ORIGIN_PRIMARY: 'https://web.fixture.invalid', PUBLIC_CORS_ORIGIN_SECONDARY: 'https://other.fixture.invalid',
    WEB_PUBLIC_ORIGIN: 'https://web.fixture.invalid', GARAGE_PUBLIC_WEB_UPSTREAM: `http://127.0.0.1:${objectPort}`,
    GARAGE_PUBLIC_BUCKET_HOST: 'fixture.test', GARAGE_PUBLIC_WEB_TLS_SERVER_NAME: 'fixture.test',
    GARAGE_S3_UPSTREAM: `http://127.0.0.1:${objectPort}`, GARAGE_S3_TLS_SERVER_NAME: 'fixture.test',
    S3_BUCKET_PROTECTED: 'pcu-protected', PROTECTED_DOWNLOAD_GLOBAL_CONNECTIONS: '512', PROTECTED_DOWNLOAD_PER_IP_CONNECTIONS: '128',
   };
   const template = readFileSync(`${root}/apps/db/${kind}.nginx.conf.template`, 'utf8')
    .replace(/\$\{([A-Z0-9_]+)\}/g, (_match, key) => { assert.ok(Object.hasOwn(values, key), key); return values[key]; })
    .replaceAll('/etc/ssl/certs/ca-certificates.crt', '/fixture/identity/trust.pem')
    .replaceAll('/var/log/nginx/access.log', '/tmp/gateway-access.log')
    .replace(/\$pcu_/g, `$fixture_${port}_`)
    .replaceAll('pcu_public_origin', `public_${port}`).replaceAll('pcu_protected_download', `protected_${port}`);
   config += template;
   gateways.push({ port, kind, valid: upstream === tlsPort && tlsName === 'pcu-file-auth.internal' });
  }
 }
 writeFileSync(`${work}/nginx.conf`, config + '}');
 // Only ephemeral loopback listeners; no shared integration stack or production data.
 docker('run', '-d', '--name', name, '--network', 'host', '--cpus', '1',
  '-v', `${work}:/fixture:ro`, '-v', `${work}/nginx.conf:/etc/nginx/nginx.conf:ro`, 'nginx:1.27-alpine');
 docker('exec', name, 'nginx', '-t');
 for (const { port, kind, valid } of gateways) {
  const before = requests.length;
  const response = await request(port, reportPath);
  assert.equal(response.status, valid ? 204 : 502, 'report traverses generated TLS vhost or fails TLS closed');
  assert.equal(response.headers.get('set-cookie'), null);
  if (!valid) assert.equal(requests.length, before, 'TLS failure must not reach API');
  else {
   assert.equal(requests.length, before + 1);
   assert.deepEqual(records.at(-1), { origin: 'https://blocked.example.com', directive: 'connect-src' });
   assert.equal(requests.at(-1).method, 'POST');
   assert.equal(requests.at(-1).url, reportPath);
   assert.equal(requests.at(-1).headers.cookie, undefined);
   assert.equal(requests.at(-1).headers.authorization, undefined);
   assert.equal(requests.at(-1).headers['content-type'], 'application/csp-report');
   assert.equal((await request(port, `/api/webgl-play/reports/${invalidToken}`)).status, 403);
   for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal((await request(port, reportPath, method)).status, 405);
   }
   assert.equal((await request(port, reportPath, 'POST', 'x'.repeat(16385))).status, 413);
   for (const path of ['/api/admin/users', '/api/webgl-play/sessions', reportPath + '/extra', '/api/webgl-play/reports/invalid']) {
    assert.equal((await request(port, path)).status, kind === 'public-origin' ? 405 : 404);
   }
   assert.equal(requests.length, before + 2, 'rejected methods, paths and oversized reports stay at gateway');
  }
  const file = await request(port, kind === 'public-origin' ? '/fixture.bin' : `/file/${token}`, 'GET');
  assert.equal(file.status, valid ? 200 : 500, 'existing file auth TLS checks');
  if (valid) assert.equal(await file.text(), 'authorized');
 }
 // Probe the actual generated vhost directly as well, so NAS restrictions cannot
 // conceal an accidentally broad TLS API proxy or a missing second-hop guard.
 const before = requests.length;
 const direct = await request(tlsPort, reportPath, 'POST', body, true);
 assert.equal(direct.status, 204);
 assert.equal(direct.headers.get('set-cookie'), null);
 assert.equal(requests.at(-1).headers.cookie, undefined);
 assert.equal(requests.at(-1).headers.authorization, undefined);
 for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE']) {
  assert.equal((await request(tlsPort, reportPath, method, '', true)).status, 405);
 }
 assert.equal((await request(tlsPort, reportPath, 'POST', 'x'.repeat(16385), true)).status, 413);
 for (const path of ['/', '/api/admin/users', '/api/webgl-play/sessions', reportPath + '/', reportPath + '/extra', '/api/webgl-play/reports/invalid']) {
  for (const method of ['GET', 'POST']) assert.equal((await request(tlsPort, path, method, body, true)).status, 404);
 }
 assert.equal((await request(tlsPort, '/api/internal/file-access', 'POST', '', true)).status, 403);
 assert.equal(requests.length, before + 1);
 for (const [path, method] of [[reportPath, 'POST'], ['/api/internal/file-access', 'GET']]) {
  assert.equal((await request(tlsPort, path, method, body, true, '127.0.0.2')).status, 403, 'non-allowlisted source is rejected');
 }
 assert.equal(requests.length, before + 1);
 const padded = body.slice(0, -1) + ',"padding":"' + 'x'.repeat(16384 - Buffer.byteLength(body) - 13) + '"}';
 assert.equal(Buffer.byteLength(padded), 16384);
 for (const { port, valid } of gateways) if (valid) {
  assert.equal((await request(port, reportPath, 'POST', padded)).status, 204, 'full 16 KiB report survives both hops');
 }
 const logs = docker('logs', name) + docker('exec', name, 'cat', '/tmp/gateway-access.log') + apiLogs;
 for (const secret of [token, invalidToken, 'payload-secret', 'credential-secret']) assert.ok(!logs.includes(secret), 'no capability, credential or body in logs');
 console.log('Generated TLS vhost + both NAS templates: report forwarding, capability rejection, method/path/body guards, credential stripping, safe logs and TLS fail-closed passed.');
} finally {
 await api.close();
}
