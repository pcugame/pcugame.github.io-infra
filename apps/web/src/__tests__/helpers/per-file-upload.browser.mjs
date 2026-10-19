// Run from the repository root. PLAYWRIGHT_MODULE may point to an existing installation.
// Exercises the production XHR adapter against real HTTP on a separate origin.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { createServer as createViteServer } from 'vite';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
let webOrigin;
const sessions = new Map();
const puts = [], options = [], aborts = [];
const api = createServer(async (req, res) => {
 if (req.headers.origin) {
  res.setHeader('Access-Control-Allow-Origin', webOrigin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type,x-amz-checksum-sha256,x-upload-signature');
  if (!req.url.includes('hidden-etag')) res.setHeader('Access-Control-Expose-Headers', 'ETag');
 }
 if (req.method === 'OPTIONS') { options.push(req.headers['access-control-request-headers']); res.writeHead(204).end(); return; }
 const chunks = [];
 req.on('aborted', () => aborts.push(req.url));
 try {
  for await (const chunk of req) chunks.push(chunk);
 } catch { return; }
 const body = Buffer.concat(chunks);
 const send = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, data })); };
 if (req.method === 'PUT') {
  const checksum = createHash('sha256').update(body).digest('base64');
  if (req.headers['x-amz-checksum-sha256'] !== checksum || req.headers['x-upload-signature'] !== 'fixture-signed-header') { res.writeHead(403).end(); return; }
  puts.push({ url: req.url, bytes: body.length });
  res.setHeader('ETag', `"${checksum}"`);
  // Delay acknowledgement after all upload bytes have left the browser.
  setTimeout(() => res.end(), 250);
  return;
 }
 const request = body.length ? JSON.parse(body.toString()) : {};
 if (req.method === 'POST' && req.url.endsWith('/direct-image-upload-sessions')) {
  const sessionId = `session-${sessions.size + 1}`;
  const session = { ...request, owner: { type: 'PROJECT', id: 7 }, kind: 'IMAGE', sessionId, generation: 1, state: 'UPLOADING', partSizeBytes: request.totalBytes, totalParts: 1, expiresAt: '2030-01-01T00:00:00Z', parts: [] };
  sessions.set(sessionId, session); send(session); return;
 }
 const id = req.url.split('/')[4];
 const session = sessions.get(id);
 if (!session) { res.writeHead(404).end(); return; }
 if (req.url.endsWith('/part-urls')) { send({ generation: 1, parts: request.parts.map(part => ({ partNumber: part.partNumber, url: `http://127.0.0.1:${api.address().port}/storage/${id}`, requiredHeaders: { 'x-amz-checksum-sha256': part.checksumSha256, 'x-upload-signature': 'fixture-signed-header' } })) }); return; }
 if (req.url.endsWith('/complete')) { session.state = 'VERIFYING'; session.readyAt = Date.now() + 500; send({ status: 'VERIFYING', sessionId: id, generation: 1, sizeBytes: session.totalBytes }); return; }
 if (req.method === 'DELETE') { session.state = 'CANCELLED'; res.writeHead(204).end(); return; }
 if (session.readyAt && Date.now() >= session.readyAt) session.state = 'READY';
 send(session);
});
await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
const vite = await createViteServer({ root: 'apps/web', define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify(`http://127.0.0.1:${api.address().port}`), 'import.meta.env.VITE_MOCK': '"false"' }, server: { host: '127.0.0.1', port: 0, watch: null, hmr: false } });
vite.middlewares.use('/__upload-browser', async (_req, res) => {
 res.setHeader('Content-Type', 'text/html');
 res.end(await vite.transformIndexHtml('/__upload-browser', '<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/src/__tests__/helpers/perFileUpload.browser-entry.tsx"></script></body></html>'));
});
vite.middlewares.stack.unshift(vite.middlewares.stack.pop());
await vite.listen();
webOrigin = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
 await page.goto(`${webOrigin}/__upload-browser`);
 await page.waitForFunction(() => window.uploadProbe);
 const cdp = await page.context().newCDPSession(page);
 await cdp.send('Network.enable');
 await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: 10 * 1024 * 1024, uploadThroughput: 512 * 1024 });
 await page.getByRole('button', { name: '전송 시작', exact: true }).click();
 await page.waitForFunction(() => window.uploadProbe.events.some(event => event.id === 'two' && event.loaded > 0 && event.percent < 99));
 await page.locator('[data-file-id="two"]').getByRole('button', { name: /취소$/ }).click();
 await page.waitForFunction(() => document.querySelector('[data-file-id="three"]')?.getAttribute('data-phase') === 'ready');
 assert.equal(await page.locator('[data-file-id="two"]').getAttribute('data-phase'), 'cancelled');
 assert.equal(sessions.size, 3);
 await mkdir('/tmp/per-file-upload-browser', { recursive: true });
 await page.screenshot({ path: '/tmp/per-file-upload-browser/desktop.png' });
 await page.setViewportSize({ width: 390, height: 844 });
 await page.screenshot({ path: '/tmp/per-file-upload-browser/mobile.png' });
 const overflow = await page.locator('.upload-file-row').evaluateAll(rows => rows.some(row => row.scrollWidth > row.clientWidth + 1));
 assert.equal(overflow, false, 'mobile rows must not overflow');
 const retry = page.locator('[data-file-id="two"]').getByRole('button', { name: /재시도$/ });
 await retry.focus(); await page.keyboard.press('Enter');
 await page.waitForFunction(() => [...document.querySelectorAll('[data-file-id]')].every(row => row.getAttribute('data-phase') === 'ready'), { timeout: 30_000 });
 assert.equal(sessions.size, 4, 'only cancelled file gets a new session');
 assert.equal(puts.filter(put => put.url.endsWith('session-1')).length, 1);
 assert.equal(puts.filter(put => put.url.endsWith('session-3')).length, 1);
 assert.ok(aborts.some(url => url.endsWith('session-2')), 'XHR abort must interrupt HTTP upload');
 assert.ok(options.some(headers => headers.includes('x-upload-signature') && headers.includes('x-amz-checksum-sha256')));
 const hidden = await page.evaluate(async port => {
  const body = new Blob(['etag']); const bytes = await crypto.subtle.digest('SHA-256', await body.arrayBuffer()); const checksum = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  const response = await window.uploadProbe.putUploadPart({ url: `http://127.0.0.1:${port}/hidden-etag`, requiredHeaders: { 'x-amz-checksum-sha256': checksum, 'x-upload-signature': 'fixture-signed-header' } }, body);
  return response.headers.get('etag');
 }, api.address().port);
 assert.equal(hidden, null, 'browser must hide ETag when CORS does not expose it');
 assert.deepEqual(errors, []);
 console.log(JSON.stringify({ result: 'passed', origins: [webOrigin, `http://127.0.0.1:${api.address().port}`], sessions: sessions.size, puts, aborts, preflights: options.length, screenshots: '/tmp/per-file-upload-browser' }, null, 2));
} finally { await browser.close(); await vite.close(); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); }
