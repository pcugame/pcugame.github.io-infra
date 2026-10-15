// Provisioned fixture requests use one protected session cookie across both slots.
// Never print request headers, bodies, cookies, or object capabilities.
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const [mode, root, slot] = process.argv.slice(2);
assert.ok(['validate', 'candidate', 'public', 'nas-public', 'nas-protected'].includes(mode));
const file = join(root, 'rolling-probes.json');
assert.equal((await stat(file)).mode & 0o077, 0, 'Smoke credentials must be private');
const config = JSON.parse(await readFile(file, 'utf8'));
for (const group of ['candidate', 'public', 'nas-public', 'nas-protected']) {
  assert.ok(Array.isArray(config[group]) && config[group].length > 0, `Missing ${group} probes`);
  for (const probe of config[group]) {
    assert.ok(probe.path?.startsWith('/') && !probe.path.startsWith('//'));
    assert.ok(['GET', 'POST', 'PATCH', 'PUT', 'HEAD'].includes(probe.method));
    assert.ok(Number.isInteger(probe.status) && [200, 201, 204, 206, 304, 416].includes(probe.status));
    assert.ok(Object.keys(probe.json ?? {}).length + Object.keys(probe.responseHeaders ?? {}).length > 0, 'A successful status alone is insufficient');
    if (probe.category === 'authenticated-write') assert.ok(['POST', 'PATCH', 'PUT'].includes(probe.method));
    assert.ok(!Object.keys(probe.headers ?? {}).some(key => key.toLowerCase() === 'cookie'), 'Every probe must use the shared cookie');
  }
}
for (const group of ['candidate', 'public']) {
  for (const category of ['authenticated-read', 'authenticated-write', 'empty-collection', 'populated-collection']) {
    assert.ok(config[group].some(probe => probe.category === category), `Missing ${group}/${category}`);
  }
  assert.ok(config[group].some(probe => probe.path === '/api/me'
    && probe.json?.['data.authenticated'] === true), 'An authenticated /api/me assertion is required');
}
for (const group of ['nas-public', 'nas-protected']) {
  assert.ok(config[group].some(probe => probe.method === 'GET' && probe.status === 200));
}
assert.ok(config.candidate.some(probe => probe.path === '/api/health/deep'));
assert.ok(config.candidate.some(probe => probe.path.startsWith('/api/internal/file-access')));
assert.ok(config.cookie && !/[\r\n]/.test(config.cookie), 'A shared smoke session cookie is required');
if (mode !== 'validate') {
  assert.ok(['a', 'b'].includes(slot));
  const origin = mode === 'candidate' ? `http://127.0.0.1:${slot === 'a' ? 4000 : 4001}` : config[`${mode}Origin`];
  if (mode !== 'candidate') assert.equal(new URL(origin).protocol, 'https:');
  for (const [index, probe] of config[mode].entries()) {
    const response = await fetch(new URL(probe.path, origin), {
      method: probe.method, headers: { Cookie: config.cookie, ...probe.headers },
      body: probe.body === undefined ? undefined : JSON.stringify(probe.body),
      redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    assert.equal(response.status, probe.status, `${mode} probe ${index} status`);
    assert.equal(response.headers.get('x-pcu-api-slot'), slot, `${mode} probe ${index} active slot`);
    for (const [key, value] of Object.entries(probe.responseHeaders ?? {})) {
      assert.equal(response.headers.get(key), value, `${mode} probe ${index} header ${key}`);
    }
    if (probe.json) {
      const json = await response.json();
      for (const [path, expected] of Object.entries(probe.json)) {
        const actual = path.split('.').reduce((value, key) => value?.[key], json);
        // Suppress assertion values, which may contain private fixture data.
        assert.ok(JSON.stringify(actual) === JSON.stringify(expected), `${mode} probe ${index} JSON ${path}`);
      }
    } else await response.arrayBuffer();
  }
}
console.log(JSON.stringify({ event: 'rolling_smoke_passed', mode }));
