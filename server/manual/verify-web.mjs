// Isolated image/browser acceptance fixture. PLAYWRIGHT_MODULE is an installed
// Playwright module path on the verification host, not a serving dependency.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const name = `pcu-manual-web-${process.pid}`;
const work = mkdtempSync(join(tmpdir(), name));
let browser;
const docker = (...args) => {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
};
try {
  chmodSync(work, 0o755);
  writeFileSync(join(work, 'web.json'), readFileSync(new URL('./config/web.json', import.meta.url)), { mode: 0o644 });
  docker('run', '-d', '--name', name, '-p', '127.0.0.1::8080', '-v', `${work}/web.json:/usr/share/nginx/html/runtime-config.json:ro`, process.env.MANUAL_WEB_IMAGE || 'pcu-manual-web:verify');
  const origin = `http://${docker('port', name, '8080/tcp')}`;
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage();
  const apiRequests = [];
  page.on('request', request => { if (request.url().startsWith('https://api.pcu.test/')) apiRequests.push(request.url()); });
  await page.route('https://api.pcu.test/**', route => { return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: [] }) }); });
  const response = await fetch(`${origin}/runtime-config.json`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('etag'), null);
  const same = await fetch(`${origin}/runtime-config.json`, { headers: { 'If-Modified-Since': new Date().toUTCString() } });
  assert.equal(same.status, 200);
  assert.equal((await fetch(`${origin}/me/projects`)).status, 200, 'SPA deep link');
  assert.equal((await fetch(`${origin}/assets/not-present.js`)).status, 404);
  await Promise.all([page.waitForRequest('https://api.pcu.test/**'), page.goto(origin)]);
  assert.ok(apiRequests.length, 'configured API origin is used');
  for (const invalid of ['{', JSON.stringify({ apiBaseUrl: 'http://localhost:4000' })]) {
    writeFileSync(join(work, 'web.json'), invalid);
    apiRequests.length = 0;
    await page.reload();
    await page.getByRole('alert').filter({ hasText: '웹 구성 오류' }).waitFor();
    assert.equal(apiRequests.length, 0, 'application must not initialize on invalid config');
  }
  // Same production image with no mounted config must return 404, not index.html.
  docker('rm', '-f', name);
  docker('run', '-d', '--name', name, '-p', '127.0.0.1::8080', process.env.MANUAL_WEB_IMAGE || 'pcu-manual-web:verify');
  const missingOrigin = `http://${docker('port', name, '8080/tcp')}`;
  assert.equal((await fetch(`${missingOrigin}/runtime-config.json`)).status, 404);
  await page.goto(missingOrigin);
  await page.getByRole('alert').filter({ hasText: '웹 구성 오류' }).waitFor();
  console.log('PASS: static image, deep links, no-store JSON, configured API request, malformed/invalid/missing config browser errors.');
} finally {
  await browser?.close();
  spawnSync('docker', ['rm', '-f', name]);
  rmSync(work, { recursive: true, force: true });
}
