// Real browser form submission against the local persistent Mock transport.
// Run Vite in mock mode first; never point this probe at production.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = process.env.PLAYWRIGHT_MODULE_PATH ? await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href) : require('playwright');
const base = process.env.MOCK_FORM_URL || 'http://127.0.0.1:5178';
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--no-sandbox'] });
try {
 const page = await browser.newPage();
 await page.goto(base, { waitUntil: 'networkidle' });
 await page.evaluate(async () => {
  const mock = await import('/src/lib/api/mock/transport.ts');
  await mock.resetMockState(); await mock.selectMockUser('owner');
 });
 await page.goto(`${base}/me/projects/1/network`);
 const form = page.locator('#network-new-request');
 await form.waitFor();
 const rows = () => page.evaluate(async () => Object.values((await (await import('/src/lib/api/mock/transport.ts')).getMockSnapshot()).networkRequests));
 async function purpose() {
  await form.getByLabel('사용 목적', { exact: true }).fill('Browser connection test');
  await form.getByLabel('CORS / 인증 설정 계획', { exact: true }).fill('External CORS and authentication configured');
 }
 async function submit(origin) {
  await purpose();
  await form.getByRole('button', { name: '검토 신청', exact: true }).click();
  await page.getByRole('heading', { name: origin, exact: true }).waitFor();
  assert((await rows()).some(row => row.origin === origin));
 }
 await form.getByLabel('호스트명', { exact: true }).fill('https://assets.example.com:*');
 await submit('https://assets.example.com:*');
 await form.getByLabel('호스트명', { exact: true }).fill('https://fixed.example.com:443/');
 await purpose();
 await form.getByRole('button', { name: '검토 신청', exact: true }).click();
 await form.getByRole('alert').filter({ hasText: '포트 정책' }).waitFor();
 assert.equal((await rows()).length, 1);
 await form.locator('summary').click();
 await form.getByLabel('포트 정책', { exact: true }).selectOption('specific');
 await submit('https://fixed.example.com');
 await form.getByLabel('호스트명', { exact: true }).fill('https://user:secret@example.com/path?token=x');
 await purpose();
 await form.getByRole('button', { name: '검토 신청', exact: true }).click();
 await form.getByRole('alert').filter({ hasText: '자격 증명' }).waitFor();
 assert.equal((await rows()).length, 2);
 await form.getByLabel('호스트명', { exact: true }).fill('wss://*.example.net:*');
 await form.getByLabel('연결 방식', { exact: true }).selectOption('WSS');
 await form.getByLabel('호스트 범위', { exact: true }).selectOption('subdomains');
 await submit('wss://*.example.net:*');
 await page.evaluate(async () => { await (await import('/src/lib/api/mock/transport.ts')).selectMockUser('ADMIN'); });
 await page.goto(`${base}/admin/webgl-network`);
 const card = page.locator('article').filter({ has: page.getByRole('heading', { name: 'https://fixed.example.com', exact: true }) });
 await card.getByLabel('검토 사유').fill('Reviewed fixed-port scope');
 await card.getByRole('button', { name: '승인', exact: true }).click();
 await card.waitFor({ state: 'detached' });
 await page.evaluate(async () => { await (await import('/src/lib/api/mock/transport.ts')).selectMockUser('owner'); });
 await page.goto(`${base}/me/projects/1/network`);
 await form.getByLabel('호스트명', { exact: true }).fill('fixed.example.com');
 await form.getByText(/새 승인 → 새 실행/).waitFor();
 await submit('https://fixed.example.com:*');
 await page.evaluate(async () => { await (await import('/src/lib/api/mock/transport.ts')).selectMockUser('ADMIN'); });
 await page.goto(`${base}/admin/webgl-network`);
 const pending = page.locator('article').filter({ has: page.getByRole('heading', { name: 'https://fixed.example.com:*', exact: true }) });
 await pending.getByText(/새 승인 → 새 실행/).waitFor();
 await pending.getByLabel('검토 사유').fill('Check overlap enforcement');
 await pending.getByRole('button', { name: '승인', exact: true }).click();
 await pending.getByRole('alert').waitFor();
 assert.equal((await rows()).find(row => row.origin === 'https://fixed.example.com:*').state, 'PENDING');
 await page.evaluate(async () => { await (await import('/src/lib/api/mock/transport.ts')).selectMockUser('owner'); });
 await page.goto(`${base}/me/projects/1/network`);
 const profile = page.getByRole('region', { name: '서비스별 신청 예시' });
 await profile.getByLabel('예시 1 선택').check();
 await profile.getByLabel('예시 사용 목적').fill('Photon example review');
 await profile.getByLabel('예시 서버 설정 계획').fill('Verify SDK endpoints and service authentication');
 await profile.getByRole('button').click();
 await profile.getByText('이미 등록됨 · 재신청하지 않습니다.').waitFor();
 assert.equal((await rows()).filter(row => row.origin === 'wss://*.photonengine.io:*').length, 1);
 console.log(JSON.stringify({ browser: await browser.version(), passed: ['all-port native form submission', 'explicit 443 conflict and normalization', 'forbidden URL rejected without write', 'WSS subdomains all ports', 'student preview and admin conflict target', 'admin approval and overlap enforcement', 'selected Photon example submission'], boundary: 'Local Mock; no production writes or live service connectivity' }));
} finally { await browser.close(); }
