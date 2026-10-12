import { WebglPlayCreateDataSchema } from '@pcu/contracts';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Env } from '../../config/env.js';
import type { PrismaClient } from '../../generated/prisma/client.js';

export const browserWebOrigin = 'http://127.0.0.1:5179';

/** Real UI and HTTP handlers with migrated PostgreSQL; fixture identities bypass OAuth only. */
export async function verifyNetworkFormBrowser(app: FastifyInstance, db: PrismaClient, config: Env,
 projectId: number, ownerSession: string, adminSession: string) {
 const playwright = await import(pathToFileURL(process.env['PLAYWRIGHT_MODULE_PATH']!).href);
 const backend = await app.listen({ host: '127.0.0.1', port: 0 });
 // Minimal object fixture: authorization and CSP come exclusively from the real gateway API.
 const runtime = createHttpServer((request, response) => {
  void (async () => {
  try {
   const auth = await fetch(`${backend}/api/internal/file-access`, { headers: {
    'x-pcu-gateway-secret': config.FILE_GATEWAY_SECRET!, 'x-pcu-file-kind': 'public',
    'x-pcu-file-uri': request.url!, 'x-pcu-file-method': 'GET',
    'x-pcu-fetch-dest': request.url!.endsWith('.js') ? 'worker' : 'document',
   } });
   if (auth.status !== 204) { response.writeHead(auth.status); response.end(); return; }
   response.writeHead(200, { 'Content-Security-Policy': auth.headers.get('x-pcu-runtime-csp')!,
    'Content-Type': request.url!.endsWith('.js') ? 'application/javascript' : 'text/html' });
   response.end(request.url!.endsWith('.js') ? 'postMessage("fixture");' : '<!doctype html><title>Runtime fixture</title>');
  } catch { response.writeHead(500); response.end(); }
  })();
 });
 await new Promise<void>(resolve => runtime.listen(0, '127.0.0.1', resolve));
 const address = runtime.address();
 if (!address || typeof address === 'string') throw new Error('Missing runtime listener');
 const originalApi = config.API_PUBLIC_URL, originalAssets = config.PUBLIC_ASSET_ORIGIN;
 config.API_PUBLIC_URL = browserWebOrigin;
 config.PUBLIC_ASSET_ORIGIN = `http://127.0.0.1:${address.port}`;
 const web = await createViteServer({ root: fileURLToPath(new URL('../../../../web/', import.meta.url)),
  configFile: fileURLToPath(new URL('../../../../web/vite.config.ts', import.meta.url)), mode: 'integration',
  define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify(browserWebOrigin), 'import.meta.env.VITE_MOCK': '"false"' },
  server: { host: '127.0.0.1', port: 5179, strictPort: true, proxy: { '/api': { target: backend } } },
 });
 let browser;
 try {
  await web.listen();
  browser = await playwright.chromium.launch({ headless: true, executablePath: process.env['BROWSER_EXECUTABLE'], args: ['--no-sandbox'] });
  const context = await browser.newContext();
  const page = await context.newPage();
  const identity = async (sid: string) => context.addCookies([{ name: config.SESSION_COOKIE_NAME, value: sid, url: browserWebOrigin, httpOnly: true, sameSite: 'Lax' }]);
  await identity(ownerSession);
  await page.goto(`${browserWebOrigin}/me/projects/${projectId}/network`);
  const form = page.locator('#network-new-request');
  await form.waitFor();
  let rowIndex = 0;
  for (const [host, mode, scope] of [
   ['scores.example.com', 'HTTPS', 'exact', 'https://scores.example.com:*'],
   ['game.example.com', 'WSS', 'subdomains', 'wss://*.game.example.com:*'],
  ]) {
   if (rowIndex) await form.getByRole('button', { name: '＋ 연결 추가', exact: true }).click();
   const entry = form.getByRole('group', { name: `연결 ${rowIndex + 1}`, exact: true });
   await entry.getByLabel('도메인 (호스트명)', { exact: true }).fill(host);
   await entry.getByLabel('연결 방식', { exact: true }).selectOption(mode);
   await entry.getByLabel('호스트 범위', { exact: true }).selectOption(scope);
   await form.getByLabel('사용 목적', { exact: true }).fill('Browser to PostgreSQL policy boundary');
   await form.getByLabel('CORS / 인증 설정 계획', { exact: true }).fill('CORS and external authentication owned by fixture team');
   rowIndex++;
  }
  await form.getByRole('button', { name: '연결 2개 신청', exact: true }).click();
  await page.locator('.network-request').filter({ has: page.getByText('https://scores.example.com:*', { exact: true }) }).waitFor();
  const origins = ['https://scores.example.com:*', 'wss://*.game.example.com:*'];
  const saved = await db.webglNetworkRequest.findMany({ where: { projectId } });
  expect(saved.map(row => row.origin).sort()).toEqual([...origins].sort());
  expect(saved.every(row => row.state === 'PENDING')).toBe(true);
  // Session issuance uses the actual browser Origin and Sec-Fetch headers through the proxy.
  const issue = async () => WebglPlayCreateDataSchema.parse(await page.evaluate(async (id: number) => {
   const response = await fetch('/api/webgl-play/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: id }) });
   if (!response.ok) throw new Error(`Session issuance failed: ${response.status}`);
   return (await response.json() as { data: unknown }).data;
  }, projectId));
  const before = await issue();
  await identity(adminSession);
  await page.goto(`${browserWebOrigin}/admin/webgl-network`);
  for (const origin of origins) {
   const requestId = saved.find(row => row.origin === origin)!.id;
   const card = page.locator('article').filter({ has: page.locator(`#reason-${requestId}`) });
   await card.getByLabel('검토 사유').fill('Reviewed actual host, scheme and all-port policy');
   await card.getByRole('button', { name: '승인', exact: true }).click();
   await card.waitFor({ state: 'detached' });
  }
  expect((await db.webglNetworkRequest.findMany({ where: { projectId } })).every(row => row.state === 'APPROVED')).toBe(true);
  await identity(ownerSession);
  await page.goto(`${browserWebOrigin}/me/projects/${projectId}/network`);
  await form.waitFor();
  const after = await issue();
  const snapshot = await db.webglPlaySession.findUniqueOrThrow({ where: { id: after.id } });
  expect([...snapshot.approvedOrigins].sort()).toEqual([...origins].sort());
  expect(snapshot.policyVersion).toBe(2);
  const oldRuntime = await page.request.get(before.iframeUrl);
  expect(oldRuntime.status()).toBe(200);
  expect(oldRuntime.headers()['content-security-policy']).not.toContain('example.com');
  for (const path of [after.iframeUrl, after.iframeUrl.replace('index.html', 'worker.js')]) {
   const response = await page.request.get(path);
   expect(response.status()).toBe(200);
   const csp = response.headers()['content-security-policy'];
   const directives = csp.split(';').map((value: string) => value.trim());
   for (const origin of origins) {
    expect(directives.find((value: string) => value.startsWith('connect-src '))).toContain(origin);
    expect(directives.filter((value: string) => !value.startsWith('connect-src ')).join(';')).not.toContain(origin);
   }
  }
  console.log(`Real form → HTTP API → PostgreSQL → admin UI → new session → document/Worker response CSP: ${await browser.version()}`);
 } finally {
  await browser?.close(); await web.close();
  await new Promise<void>((resolve, reject) => runtime.close(error => error ? reject(error) : resolve()));
  config.API_PUBLIC_URL = originalApi; config.PUBLIC_ASSET_ORIGIN = originalAssets;
 }
}
