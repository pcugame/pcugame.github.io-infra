#!/usr/bin/env node
// Actual, unchanged Unity export acceptance through the compiled isolated shell.
// Inputs: WEBGL_FIXTURE_ZIP and WEBGL_FIXTURE_DIR (the matching extracted export root).
// Requires a built API; Playwright may be supplied via PLAYWRIGHT_MODULE_PATH.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { validateBoundedZipFile } from '../apps/api/dist/modules/archive/bounded-zip-validator.js';
import { analyzeWebglArchive } from '../apps/api/dist/modules/webgl/archive.js';
import { analyzeWebglDisplayArchive } from '../apps/api/dist/modules/webgl/display-analysis.js';
import { renderPlayShell, playShellHeaders } from '../apps/api/dist/modules/webgl-play/runtime-ui.js';
import { runtimeCsp } from '../apps/api/dist/modules/webgl-play/service.js';
const require = createRequire(import.meta.url);
const playwright = process.env.PLAYWRIGHT_MODULE_PATH
 ? await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href) : require('playwright');
const archivePath = process.env.WEBGL_FIXTURE_ZIP;
const fixtureDir = process.env.WEBGL_FIXTURE_DIR;
assert(archivePath && fixtureDir, 'Set WEBGL_FIXTURE_ZIP and WEBGL_FIXTURE_DIR to the same unchanged Unity export');
const archiveBytes = await readFile(archivePath);
const summary = await validateBoundedZipFile(archivePath, { profile: 'WEBGL', maxArchiveBytes: archiveBytes.length });
const layout = analyzeWebglArchive(summary);
const analysis = await analyzeWebglDisplayArchive({ archivePath, layout });
assert.notEqual(analysis.kind, 'unknown', JSON.stringify(analysis));
const allowedPaths = new Set(layout.files.values());
const token = 'a'.repeat(64), controlSecret = 'c'.repeat(64);
let creates = 0, loads = 0, config, assetOrigin;
const serve = handler => new Promise(resolve => {
 const server = http.createServer((req, res) => Promise.resolve(handler(req, res)).catch(error => {
  res.writeHead(500); res.end(); console.error(error); process.exitCode = 1;
 }));
 server.listen(0, '127.0.0.1', () => resolve(server));
});
const origin = server => `http://127.0.0.1:${server.address().port}`;
const api = await serve((req, res) => {
 if (req.url === '/play/projects/1') {
  res.writeHead(200, { ...playShellHeaders(config), 'Content-Type': 'text/html' });
  return res.end(renderPlayShell(config, 1));
 }
 if (req.method !== 'POST') { res.writeHead(404); return res.end(); }
 const creating = req.url === '/api/webgl-play/sessions';
 if (creating) creates++;
 res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
 res.end(JSON.stringify({ ok: true, data: creating ? {
  id: '11111111-1111-4111-8111-111111111111', controlSecret,
  iframeUrl: `${assetOrigin}/runtime/${token}/index.html`, projectTitle: 'Actual Unity display acceptance',
  webglDisplayKind: analysis.kind, webglDisplayWidth: analysis.width, webglDisplayHeight: analysis.height,
  expiresAt: new Date(Date.now() + 900000).toISOString(), absoluteExpiresAt: new Date(Date.now() + 28800000).toISOString(),
 } : { closed: true, expiresAt: new Date(Date.now() + 900000).toISOString(), absoluteExpiresAt: new Date(Date.now() + 28800000).toISOString() } }));
});
const apiOrigin = origin(api);
const assets = await serve(async (req, res) => {
 const pathname = new URL(req.url, 'http://local').pathname;
 const prefix = `/runtime/${token}/`;
 const relative = pathname.startsWith(prefix) ? decodeURIComponent(pathname.slice(prefix.length)) : '';
 if (!allowedPaths.has(relative)) { res.writeHead(404); return res.end(); }
 const bytes = await readFile(path.join(fixtureDir, relative));
 if (relative === 'index.html') loads++;
 // Fixture files remain unchanged. Native compressed exports keep their encoding.
 const encoding = relative.endsWith('.gz') ? 'gzip' : relative.endsWith('.br') ? 'br' : null;
 const extension = path.extname(encoding ? relative.slice(0, -3) : relative);
 res.writeHead(200, {
  'Content-Type': ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.ico': 'image/x-icon' })[extension] ?? 'application/octet-stream',
  ...(encoding ? { 'Content-Encoding': encoding } : {}),
  'Content-Security-Policy': runtimeCsp(assetOrigin, token, apiOrigin),
  'Cross-Origin-Resource-Policy': 'cross-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin', 'Cache-Control': 'no-store',
 });
 res.end(bytes);
});
assetOrigin = origin(assets);
config = { API_PUBLIC_URL: apiOrigin, WEB_PUBLIC_URL: apiOrigin, PUBLIC_ASSET_ORIGIN: assetOrigin };
let browser;
const measurements = [], logs = [];
try {
 browser = await playwright.chromium.launch({ headless: true,
  ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
 });
 const page = await browser.newPage({ viewport: { width: 1800, height: 1200 } });
 await page.addInitScript(() => {
  window.cspViolations = [];
  document.addEventListener('securitypolicyviolation', event => cspViolations.push({ directive: event.effectiveDirective, blocked: event.blockedURI }));
 });
 page.on('console', message => logs.push({ type: message.type(), text: message.text() }));
 await page.goto(`${apiOrigin}/play/projects/1`);
 const iframe = page.locator('#game iframe');
 await iframe.waitFor();
 const game = await (await iframe.elementHandle()).contentFrame();
 if (analysis.kind === 'fixed') {
  await game.waitForFunction(() => document.querySelector('#unity-loading-bar')?.style.display === 'none' || !!window.gameInstance, null, { timeout: 90000 });
 } else {
  // The controlled minimal template does not publish its instance. The real sample
  // scene's completion log establishes engine startup without rewriting its JS.
  const deadline = Date.now() + 90000;
  while (!logs.some(log => log.text.includes('UnloadTime:')) && Date.now() < deadline) await page.waitForTimeout(100);
  assert(logs.some(log => log.text.includes('UnloadTime:')), 'Unity sample scene did not initialize');
 }
 // Allow the engine splash to finish before visual acceptance.
 await page.waitForTimeout(8000);
 const start = { creates, loads, src: await iframe.getAttribute('src') };
 await game.evaluate(() => {
  window.acceptanceIdentity = Math.random(); window.acceptanceClicks = [];
  document.addEventListener('pointerdown', event => acceptanceClicks.push([event.clientX, event.clientY]));
 });
 const identity = await game.evaluate(() => acceptanceIdentity);
 async function measure(name, gameFullscreen = false) {
  await page.waitForTimeout(250);
  const box = await iframe.boundingBox(), stage = await page.locator('#game').boundingBox();
  const inner = await game.evaluate(() => ({ viewport: [innerWidth, innerHeight],
   scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
   elements: [...document.querySelectorAll('canvas,#unity-fullscreen-button,#unity-build-title')].map(element => ({ id: element.id, rect: element.getBoundingClientRect().toJSON() })),
  }));
  assert.deepEqual({ creates, loads, src: await iframe.getAttribute('src') }, start);
  assert.equal(await game.evaluate(() => acceptanceIdentity), identity);
  if (!gameFullscreen) {
   assert(box.width <= stage.width + 1 && box.height <= stage.height + 1);
   if (analysis.kind === 'fixed') assert.deepEqual(inner.viewport, [analysis.width, analysis.height]);
   else assert(Math.abs(box.width - stage.width) < 1 && Math.abs(box.height - stage.height) < 1);
   assert(inner.scroll[0] <= inner.viewport[0] && inner.scroll[1] <= inner.viewport[1], JSON.stringify(inner));
   for (const { rect } of inner.elements) {
    assert(rect.x >= -0.1 && rect.y >= -0.1 && rect.right <= inner.viewport[0] + 0.1 && rect.bottom <= inner.viewport[1] + 0.1, JSON.stringify(inner));
   }
   const canvas = inner.elements.find(element => element.id === 'unity-canvas').rect;
   const expected = [canvas.x + canvas.width / 2, canvas.y + canvas.height / 2];
   await page.mouse.click(box.x + expected[0] * box.width / inner.viewport[0], box.y + expected[1] * box.height / inner.viewport[1]);
   const click = await game.evaluate(() => acceptanceClicks.at(-1));
   assert(click && Math.abs(click[0] - expected[0]) <= 2 && Math.abs(click[1] - expected[1]) <= 2);
  }
  measurements.push({ name, box, stage, inner, creates, loads });
  if (process.env.BROWSER_ARTIFACT_DIR) {
   await mkdir(process.env.BROWSER_ARTIFACT_DIR, { recursive: true });
   await page.screenshot({ path: path.join(process.env.BROWSER_ARTIFACT_DIR, `${name}.png`) });
  }
 }
 await measure('wide');
 const devtools = await page.context().newCDPSession(page);
 await devtools.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.25 });
 assert.equal(await game.evaluate(() => acceptanceIdentity), identity);
 assert.deepEqual({ creates, loads, src: await iframe.getAttribute('src') }, start);
 await devtools.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
 await measure('visual-viewport-zoom-exit');
 for (const viewport of [{ width: 900, height: 650 }, { width: 600, height: 450 }]) {
  await page.setViewportSize(viewport); await measure(`${viewport.width}x${viewport.height}`);
 }
 await page.setViewportSize({ width: 1800, height: 1200 });
 await page.locator('#fullscreen').click(); await page.waitForFunction(() => !!document.fullscreenElement); await measure('host-fullscreen');
 await page.locator('#fullscreen').click(); await page.waitForFunction(() => !document.fullscreenElement); await measure('host-exit');
 if (await game.locator('#unity-fullscreen-button').count()) {
  await game.locator('#unity-fullscreen-button').click(); await game.waitForFunction(() => !!document.fullscreenElement); await measure('game-fullscreen', true);
  await game.evaluate(() => document.exitFullscreen()); await game.waitForFunction(() => !document.fullscreenElement); await measure('game-exit');
 }
 const csp = { shell: await page.evaluate(() => cspViolations), game: await game.evaluate(() => cspViolations) };
 assert.deepEqual(csp, { shell: [], game: [] });
 console.log(JSON.stringify({ passed: true, browser: browser.version(), fixture: archivePath,
  sha256: createHash('sha256').update(archiveBytes).digest('hex'), analysis, measurements, csp,
  unityLogs: logs.filter(log => /Unity|OpenGL|Renderer|WebGL|Initialize engine|UnloadTime/.test(log.text)),
  limits: ['Fixture bytes served unchanged; fixture provenance/adaptations must be recorded separately', 'Local mock session controls; authenticated API verified separately', 'Software WebGL on loopback, not production GPU/TLS acceptance'],
 }, null, 2));
} finally {
 await browser?.close();
 await Promise.all([api, assets].map(server => new Promise(resolve => server.close(resolve))));
}
