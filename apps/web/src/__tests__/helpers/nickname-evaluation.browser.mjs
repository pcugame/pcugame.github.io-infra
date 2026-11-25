// Run from the repository root after building @pcu/contracts.
// Supply PLAYWRIGHT_MODULE and CHROME_PATH to use an existing browser setup.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const dataset = { name: 'human.jsonl', mimeType: 'application/x-ndjson', buffer: Buffer.from(
  Array.from({ length: 57 }, (_, i) => JSON.stringify({ id: `case-${i}`, nickname: `가상닉네임${i}`,
    reference: { expectedReason: '사람의 검토 가설', expectedScore: 50 } })).join('\n')) };
const firstId = 'case-0';
const vite = await createServer({
  root: 'apps/web', mode: 'mock',
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
});

let browser;
try {
  await vite.listen();
  const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  const input = name => page.getByLabel(name, { exact: true });
  const button = name => page.getByRole('button', { name, exact: true });
  const panel = name => page.locator('.lab-panel').filter({ has: page.getByRole('heading', { name, exact: true }) });
  await page.goto(`${base}/lab/nickname-evaluation`);
  await input('Mock 사용자').selectOption('OPERATOR');
  await page.getByRole('heading', { name: '접근 권한이 없습니다' }).waitFor();
  await input('Mock 사용자').selectOption('BETA_TESTER');
  await page.getByText('개발용 모의 진행률', { exact: false }).waitFor();
  const defaultHelp = button('가져오기 기본 용도 도움말');
  await defaultHelp.hover();
  const tooltip = page.getByRole('tooltip');
  await tooltip.waitFor();
  assert.match(await tooltip.innerText(), /이미 지정된 용도는 유지/);
  await tooltip.hover();
  assert.equal(await tooltip.isVisible(), true);
  await page.keyboard.press('Escape');
  await tooltip.waitFor({ state: 'hidden' });
  await button('고정 평가 지침 도움말').focus();
  await tooltip.waitFor();
  assert.match(await tooltip.innerText(), /같은 조건에서 결과를 비교/);
  await page.keyboard.press('Escape');
  await tooltip.waitFor({ state: 'hidden' });
  await page.keyboard.press('Tab');
  assert.equal(await input('고정 평가 지침').evaluate(el => el === document.activeElement), true);
  await input('데이터셋 등록 · 최대 4 MiB').setInputFiles(dataset);
  await page.getByText('57개 케이스를 검증해 등록했습니다.').waitFor();

  await page.getByText('테스트케이스 미리보기', { exact: false }).click();
  await input('케이스 검색').fill(firstId);
  await page.locator('.lab-cases label input').first().check();
  await input('검색 모드').selectOption('model_tool_call');
  await button('1개 평가 실행').click();
  await page.getByText('완료 · 1 / 1개 처리').waitFor();
  await input('실험 크기').selectOption('10');
  await button('10개 평가 실행').click();
  await page.getByText('완료 · 10 / 10개 처리').waitFor();
  await input('실험 크기').selectOption('50');
  await button('50개 평가 실행').click();
  await page.getByText('완료 · 50 / 50개 처리').waitFor();
  await input('실험 크기').selectOption('all');
  await button('57개 평가 실행').click();
  await button('실행 취소').waitFor();
  await page.reload();
  await page.getByText('완료 · 57 / 57개 처리').waitFor({ timeout: 7570 });

  await input('처리 상태').selectOption('SUCCEEDED');
  const results = panel('실험 결과');
  await input('한 사례씩 검수 (정답은 공개 전 숨김)').uncheck();
  await results.getByText('1 / 3 페이지 · 총 57개').waitFor();
  await results.getByRole('button', { name: '다음', exact: true }).click();
  await results.getByText('2 / 3 페이지 · 총 57개').waitFor();
  await input('결과 검색').fill(firstId);
  await results.locator('.lab-row summary').first().click();
  await results.getByText('화면 검증용 합성 판단, 실제 모델 평가 아님', { exact: true }).waitFor();

  await input('비교할 실험').selectOption({ index: 1 });
  await input('비교 결과 검색').fill(firstId);
  await panel('실험 비교').locator('.lab-row summary').first().click();
  await page.getByRole('heading', { name: '기준 실험', exact: true }).waitFor();
  const download = page.waitForEvent('download');
  await button('JSON 다운로드').click();
  const saved = await download;
  const exported = JSON.parse(await readFile(await saved.path(), 'utf8'));
  assert.equal(exported.run.provider, 'mock');
  assert.equal(exported.results.length, 57);
  assert.ok(exported.results.every(result => result.jsonValid));
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

  await input('Mock 사용자').selectOption('OPERATOR');
  await page.getByRole('heading', { name: '접근 권한이 없습니다' }).waitFor();
  assert.equal(await input('고정 평가 지침').count(), 0);
  await input('Mock 사용자').selectOption('ADMIN');
  await input('고정 평가 지침').waitFor();
  await page.setViewportSize({ width: 1280, height: 900 });
  await input('실험 크기').selectOption('1');
  await input('가져오기 기본 용도').selectOption('test');
  await input('데이터셋 등록 · 최대 4 MiB').setInputFiles({ name: 'human.csv', mimeType: 'text/csv', buffer: Buffer.from('nickname,expectedReason,expectedScore,split\r\n가상연구하나,"검토할 가설, 인용",75,train\r\n가상연구둘,일반적인 해석,0,train\r\n가상모호닉네임,판단이 어려운 사례,50,\r\n') });
  await page.getByText('3개 케이스를 검증해 등록했습니다.').waitFor();
  assert.equal(await input('고정 평가 지침').getAttribute('readonly'), '');
  await page.getByText('테스트케이스 미리보기', { exact: false }).click();
  await input('케이스 검색').fill('가상연구하나');
  await page.getByText('기대 근거 (가설): 검토할 가설, 인용', { exact: false }).waitFor();
  await page.locator('.lab-cases label input').first().check();
  await button('1개 평가 실행').click();
  await page.getByText('완료 · 1 / 1개 처리').waitFor();
  await input('평가 대상 용도').selectOption('train');
  await input('실험 크기').selectOption('all');
  await button('2개 평가 실행').click();
  await page.getByText('완료 · 2 / 2개 처리').waitFor();
  await input('평가 대상 용도').selectOption('');
  await input('실험 크기').selectOption('custom');
  await input('사용자 지정 개수').fill('3');
  await input('설정을 확정하고 최종 평가로 실행').check();
  await button('3개 평가 실행').click();
  await page.getByText('완료 · 3 / 3개 처리').waitFor();
  await input('한 사례씩 검수 (정답은 공개 전 숨김)').uncheck();
  await results.locator('.lab-row summary').first().click();
  await results.getByText('판단 신뢰도', { exact: true }).first().waitFor();
  await results.getByText('사람의 기대 근거 (검토 가설)', { exact: true }).first().waitFor();
  const nicknameDownload = page.waitForEvent('download');
  await button('JSON 다운로드').click();
  const nicknameSaved = await nicknameDownload;
  const nicknameExport = JSON.parse(await readFile(await nicknameSaved.path(), 'utf8'));
  assert.equal(nicknameExport.run.schemaVersion, '3');
  assert.equal(Object.hasOwn(nicknameExport.run, 'datasetType'), false);
  assert.equal(nicknameExport.results.length, 3);
  assert.equal(nicknameExport.results[2].testCase.split, 'test');
  assert.ok(nicknameExport.results.every(r => r.output.schemaVersion === '2'));
  await page.screenshot({ path: '/tmp/lab-nickname-desktop.png', fullPage: true });
  await page.reload();
  await page.getByText('완료 · 3 / 3개 처리').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: '/tmp/lab-nickname-mobile.png', fullPage: true });
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      for (const name of ['가져오기 기본 용도', '고정 평가 지침', '답변의 다양성', '응답 길이 제한']) {
        const help = button(`${name} 도움말`);
        await help.click();
        await tooltip.waitFor();
        const bounds = await tooltip.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, `${name} overflows at ${width}px`);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('body *')]
            .filter(el => el.getBoundingClientRect().right > innerWidth).map(el => `${el.tagName}.${el.className}`).slice(0, 10))));
        if (name === '가져오기 기본 용도') await page.screenshot({ path: `/tmp/lab-help-${width}-${theme}.png` });
        await page.keyboard.press('Escape');
        await tooltip.waitFor({ state: 'hidden' });
      }
    }
  }
  const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const touchPage = await touch.newPage();
  await touchPage.goto(`${base}/lab/nickname-evaluation`);
  await touchPage.getByLabel('Mock 사용자', { exact: true }).selectOption('BETA_TESTER');
  await touchPage.getByRole('button', { name: '가져오기 기본 용도 도움말', exact: true }).tap();
  await touchPage.getByRole('tooltip').waitFor();
  await touchPage.getByRole('heading', { name: '새 실험', exact: true }).tap();
  await touchPage.getByRole('tooltip').waitFor({ state: 'hidden' });
  await touch.close();
  await page.goto(`${base}/admin/beta-users`);
  await input('사용자 검색').fill('2088099');
  await button('베타 권한 부여').click();
  await button('베타 권한 회수').click();
  await button('베타 권한 부여').waitFor();
  assert.deepEqual(errors, []);
  console.log('Passed nickname JSONL 1/10/50/all and CSV import, preview, fixed instructions, selection, split/all/custom, export, reload, roles, help hover/focus/Escape/touch and 1280/390/320px light/dark layouts.');
} finally {
  await browser?.close();
  await vite.close();
}
