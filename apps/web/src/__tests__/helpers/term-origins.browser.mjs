// Run from the repository root after building @pcu/contracts.
// Supply PLAYWRIGHT_MODULE and CHROME_PATH to use an existing browser setup.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const dataset = fileURLToPath(new URL('../../../../../benchmarks/term-origins/benchmark-500.jsonl', import.meta.url));
const firstId = JSON.parse((await readFile(dataset, 'utf8')).split('\n')[0]).id;
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
  await page.goto(`${base}/lab/term-origins`);
  await input('Mock 사용자').selectOption('OPERATOR');
  await page.getByRole('heading', { name: '접근 권한이 없습니다' }).waitFor();
  await input('Mock 사용자').selectOption('BETA_TESTER');
  await page.getByText('개발용 모의 진행률', { exact: false }).waitFor();
  assert.equal(await input('검색 모드').inputValue(), 'backend_retrieval');
  assert.equal(await input('데이터셋 등록 · JSONL 500개').count(), 0);
  await input('닉네임').fill('계집');
  await button('검색 후 평가').click();
  const directResult = panel('실험 결과').locator('.lab-row[open]');
  await directResult.getByText('판정 이유').waitFor();
  const firstRun = await input('저장된 실험').inputValue();
  await input('시스템 프롬프트').fill('현대 용례를 따로 평가하세요.');
  await button('검색 후 평가').click();
  await page.waitForFunction(id => new URLSearchParams(location.search).get('run') !== id, firstRun);
  await directResult.getByText('판정 이유').waitFor();
  assert.equal(await input('닉네임').inputValue(), '계집');
  assert.equal(await input('시스템 프롬프트').inputValue(), '현대 용례를 따로 평가하세요.');
  await input('비교할 실험').selectOption(firstRun);
  await panel('실험 비교').getByText('판정 이유', { exact: true }).nth(1).waitFor();
  await page.getByRole('tab', { name: '데이터셋 실험' }).click();
  assert.equal(await input('데이터셋').inputValue(), '');
  await input('데이터셋 등록 · JSONL 500개').setInputFiles(dataset);
  await page.getByText('500개 케이스를 검증해 등록했습니다.').waitFor();

  await page.getByText('테스트케이스 미리보기', { exact: false }).click();
  await input('케이스 검색').fill(firstId);
  await page.locator('.lab-cases label input').first().check();
  await input('시스템 프롬프트').fill('화면 점검용 시스템 프롬프트');
  await input('검색 모드').selectOption('model_tool_call');
  await button('1개 평가 실행').click();
  await page.getByText('완료 · 1 / 1개 처리').waitFor();
  await input('실험 크기').selectOption('10');
  await input('시스템 프롬프트').fill('두 번째 문맥 분석');
  await button('10개 평가 실행').click();
  await page.getByText('완료 · 10 / 10개 처리').waitFor();
  await input('실험 크기').selectOption('500');
  await button('500개 평가 실행').click();
  await button('실행 취소').waitFor();
  await page.reload();
  await page.getByText('완료 · 500 / 500개 처리').waitFor({ timeout: 75000 });

  await input('처리 상태').selectOption('SUCCEEDED');
  const results = panel('실험 결과');
  await results.getByText('1 / 20 페이지 · 총 500개').waitFor();
  await results.getByRole('button', { name: '다음' }).click();
  await results.getByText('2 / 20 페이지 · 총 500개').waitFor();
  await input('결과 검색').fill(firstId);
  await results.locator('.lab-row summary').first().click();
  await results.getByText('개발용 합성 어원 응답', { exact: true }).waitFor();

  await input('비교할 실험').selectOption({ index: 1 });
  await input('비교 결과 검색').fill(firstId);
  await panel('실험 비교').locator('.lab-row summary').first().click();
  await page.getByRole('heading', { name: '기준 실험', exact: true }).waitFor();
  const download = page.waitForEvent('download');
  await button('JSON 다운로드').click();
  const saved = await download;
  const exported = JSON.parse(await readFile(await saved.path(), 'utf8'));
  assert.equal(exported.run.provider, 'mock');
  assert.equal(exported.results.length, 500);
  assert.ok(exported.results.every(result => result.jsonValid));
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

  await input('Mock 사용자').selectOption('OPERATOR');
  await page.getByRole('heading', { name: '접근 권한이 없습니다' }).waitFor();
  assert.equal(await input('시스템 프롬프트').count(), 0);
  await input('Mock 사용자').selectOption('ADMIN');
  await input('시스템 프롬프트').waitFor();
  await page.goto(`${base}/admin/beta-users`);
  await input('사용자 검색').fill('2088099');
  await button('베타 권한 부여').click();
  await button('베타 권한 회수').click();
  await button('베타 권한 부여').waitFor();
  assert.deepEqual(errors, []);
  console.log('Passed nickname prompt comparison and dataset workflows for 1, 10 and 500 cases, including reload, export and role changes.');
} finally {
  await browser?.close();
  await vite.close();
}
