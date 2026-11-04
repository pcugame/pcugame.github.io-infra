// Run from the repository root with PLAYWRIGHT_MODULE and CHROME_PATH if needed.
// Uses a fresh mock browser context; production services are never contacted.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const artifacts = process.env.MATERIAL_CAPTURE_DIR ?? '/tmp/material-tabs-captures';
await mkdir(artifacts, { recursive: true });
const vite = await createServer({ root: 'apps/web', mode: 'mock', server: { host: '127.0.0.1', port: 0, watch: null, hmr: false } });
await vite.listen();
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true, args: ['--no-sandbox'] });
const errors = [];
const stage = (page, name) => page.getByRole('navigation', { name: '작품 작성 단계' }).getByRole('button', { name }).click();
const tab = (page, name) => page.getByRole('tab', { name: new RegExp(`^${name}`) });
const setup = async () => {
 const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
 // Keep developer-only controls from covering the product's actions during QA.
 await context.addInitScript(() => window.addEventListener('DOMContentLoaded', () => {
  const style = document.createElement('style'); style.textContent = '.mock-switcher { position: static !important; }'; document.head.append(style);
 }));
 const page = await context.newPage();
 page.on('pageerror', error => errors.push(error.message));
 page.on('dialog', dialog => dialog.accept());
 return { context, page };
};
async function capture(page, name) {
 await page.locator('.material-manager').scrollIntoViewIfNeeded();
 await page.screenshot({ path: `${artifacts}/${name}.png`, fullPage: true });
 const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1 || [...document.querySelectorAll('.material-file, .material-panel')].some(row => row.clientWidth > 0 && row.scrollWidth > row.clientWidth + 1));
 assert.equal(overflow, false, `${name}: horizontal overflow`);
 assert.ok(await page.locator('[role=tab][aria-selected=true]').evaluate(tab => { const parent = tab.parentElement.getBoundingClientRect(), selected = tab.getBoundingClientRect(); return selected.left >= parent.left - 1 && selected.right <= parent.right + 1; }), `${name}: selected tab stays visible`);
}
try {
 const { context, page } = await setup();
 await page.goto(`${origin}/admin/projects/1/edit`);
 await stage(page, '파일 업로드'); await tab(page, '동영상').click();
 for (const width of [320, 390, 768, 1440]) for (const theme of ['light', 'dark']) {
  await page.setViewportSize({ width, height: 900 });
  await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
  await capture(page, `normal-${width}-${theme}`);
 }
 await page.setViewportSize({ width: 320, height: 844 }); await tab(page, '웹 빌드').click();
 assert.ok(await page.locator('.material-panel:visible header').evaluate(header => header.clientHeight < 70), 'Web build heading stays compact');
 await capture(page, 'web-320');
 await page.setViewportSize({ width: 390, height: 844 });
 await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
 const more = page.getByRole('button', { name: /더보기$/ }).first();
 await more.focus(); await page.keyboard.press('Enter'); assert.equal(await page.getByRole('menu').count(), 1);
 await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape'); assert.equal(await more.evaluate(button => button === document.activeElement), true);
 await tab(page, '기타 자료').click();
 const file = { name: '아주_긴_파일이름_화면과_메뉴의_가로넘침을_확인하는_테스트_자료_2026.txt', mimeType: 'text/plain', buffer: Buffer.alloc(2 * 1024 * 1024, 65) };
 await page.locator('[data-file-group="materials"] input[type=file]').setInputFiles(file);
 await page.evaluate(async () => { const mock = await import('/src/lib/api/mock/transport.ts'); await mock.setMockControls({ worker: 'paused', delayMs: 200 }); });
 await page.getByRole('button', { name: '변경사항 적용', exact: true }).click();
 await page.locator('[data-phase="uploading"]').waitFor({ timeout: 30000 }); await capture(page, 'uploading-390');
 await tab(page, '웹 빌드').click();
 await page.locator('[data-phase="verifying"]').waitFor({ state: 'attached', timeout: 30000 });
 assert.equal(await tab(page, '웹 빌드').getAttribute('aria-selected'), 'true');
 assert.equal(await page.locator('dialog[open]').count(), 0);
 await page.evaluate(async () => { const mock = await import('/src/lib/api/mock/transport.ts'); await mock.setMockControls({ worker: 'fail', delayMs: 0 }); });
 await page.getByRole('button', { name: '실패 파일 보기' }).waitFor({ timeout: 30000 });
 assert.equal(await tab(page, '웹 빌드').getAttribute('aria-selected'), 'true');
 await page.getByRole('button', { name: '실패 파일 보기' }).click();
 await page.locator('.material-file__details').filter({ hasText: '테스트_자료' }).locator('summary').click();
 for (const width of [320, 390, 768, 1440]) for (const theme of ['light', 'dark']) {
  await page.setViewportSize({ width, height: 900 });
  await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
  await capture(page, `failed-${width}-${theme}`);
 }
 await page.evaluate(async () => { const mock = await import('/src/lib/api/mock/transport.ts'); await mock.setMockControls({ worker: 'auto', delayMs: 0 }); });
 const stableId = await page.locator('[data-file-id]').getAttribute('data-file-id');
 await page.reload(); await stage(page, '파일 업로드'); await tab(page, '기타 자료').click();
 assert.equal(await page.locator('[data-file-id]').getAttribute('data-file-id'), stableId);
 await page.getByRole('button', { name: '변경사항 적용', exact: true }).click();
 await page.locator('[data-phase="failed"]').waitFor({ timeout: 30000 });
 await page.locator('[data-file-id] input[type=file]').setInputFiles(file);
 await page.locator('[data-phase="ready"]').waitFor({ timeout: 30000 });
 await page.getByRole('button', { name: '변경사항 적용', exact: true }).click();
 await page.getByText('적용되었습니다.', { exact: true }).waitFor({ timeout: 30000 });
 assert.equal(await page.locator('.material-file__name').filter({ hasText: '테스트_자료' }).count(), 1);
 assert.equal(await page.locator('[data-file-id]').count(), 0);
 await context.close();
 for (const role of ['ADMIN', 'owner']) {
  const { context, page } = await setup();
  await page.goto(origin);
  await page.getByRole('combobox', { name: 'Mock 사용자' }).selectOption(role);
  await page.waitForFunction(async role => { const mock = await import('/src/lib/api/mock/transport.ts'); return (await mock.reloadMockState()).authUser === role; }, role);
  await page.goto(`${origin}/${role === 'ADMIN' ? 'admin' : 'me'}/projects/new`);
  await page.getByLabel('작품명 *', { exact: true }).fill(`자료 관리 검증 ${role}`);
  const exhibition = page.getByLabel('전시회 *', { exact: true });
  await exhibition.locator('option:not([value=""]):not(:disabled)').first().waitFor({ state: 'attached' });
  await exhibition.selectOption(await exhibition.locator('option:not([value=""]):not(:disabled)').first().getAttribute('value'));
  await page.getByLabel('공개 범위', { exact: true }).selectOption('STAFF');
  await stage(page, '게임 정보');
  await page.getByLabel('이름', { exact: true }).fill('테스트학생'); await page.getByLabel('학번', { exact: true }).fill('20260001');
  await stage(page, '파일 업로드'); assert.equal(await tab(page, '포스터').getAttribute('aria-selected'), 'true');
  await capture(page, `new-empty-${role}`);
  await tab(page, '기타 자료').click();
  await page.locator('[data-file-group="materials"] input').setInputFiles({ name: 'registration.txt', mimeType: 'text/plain', buffer: Buffer.from('registration') });
  assert.equal(await page.evaluate(async () => { const mock = await import('/src/lib/api/mock/transport.ts'); return Object.keys((await mock.reloadMockState()).sessions).length; }), 0);
  await stage(page, '미리보기'); await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.waitForURL(/\/admin\/projects\/\d+\/edit/, { timeout: 30000 });
  await page.getByRole('heading', { name: '작품 수정', exact: true }).waitFor();
  await stage(page, '파일 업로드'); await tab(page, '기타 자료').click();
  assert.equal(await page.locator('.material-file__name').filter({ hasText: 'registration.txt' }).count(), 1);
  assert.equal(await page.locator('dialog[open]').count(), 0);
  await page.getByRole('button', { name: 'registration.txt 더보기' }).click(); await page.getByRole('menuitem', { name: '삭제', exact: true }).click();
  assert.ok(await page.getByText('삭제 예정', { exact: true }).count());
  await page.getByRole('button', { name: 'registration.txt 더보기' }).click(); await page.getByRole('menuitem', { name: '삭제 취소' }).click();
  await context.close();
 }
 assert.deepEqual(errors, []);
 console.log(JSON.stringify({ result: 'passed', artifacts, widths: [320, 390, 768, 1440], themes: ['light', 'dark'], roles: ['ADMIN', 'USER'] }));
} finally { await browser.close(); await vite.close(); }
