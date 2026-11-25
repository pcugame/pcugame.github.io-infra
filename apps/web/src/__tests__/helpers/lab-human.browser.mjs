// Real browser, persistent mock backend. No LLM or training job is invoked.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const vite = await createServer({ root: 'apps/web', mode: 'mock', server: { host: '127.0.0.1', port: 0, watch: null, hmr: false } });
let browser;
try {
  await vite.listen();
  const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const button = name => page.getByRole('button', { name, exact: true });
  const label = name => page.getByLabel(name, { exact: true });
  await page.goto(`${base}/lab/nickname-evaluation`);
  await label('Mock 사용자').selectOption('BETA_TESTER');
  await label('데이터셋 등록 · 최대 4 MiB').setInputFiles({ name: 'human.jsonl', mimeType: 'application/x-ndjson', buffer: Buffer.from(
    ['normal', 'ambiguous', 'test'].map((id, i) => JSON.stringify({ id, nickname: `가상산책${i}`, familyId: id, split: id === 'test' ? 'test' : 'train',
      reference: { expectedReason: '참조 근거 비공개 검사', expectedScore: 0 } })).join('\n')) });
  await page.getByText('3개 케이스를 검증해 등록했습니다.').waitFor();
  await label('실험 크기').selectOption('all');
  await label('검색 모드').selectOption('no_search');
  await label('설정을 확정하고 최종 평가로 실행').check();
  await button('3개 평가 실행').click();
  await page.getByText('완료 · 3 / 3개 처리').waitFor();
  const review = page.getByRole('region', { name: '사람 검수' });
  await review.getByText('모델 응답과 근거').waitFor();
  assert.equal(await review.getByText('참조 근거 비공개 검사', { exact: true }).count(), 0);
  for (const cohort of ['normal', 'ambiguous']) {
    await review.getByRole('button', { name: '1 정답', exact: true }).click();
    await label('사례 유형').selectOption(cohort);
    await label('판단 근거 적합성').selectOption('true');
    await label('해석·난독화 복원').selectOption('true');
    await review.getByRole('button', { name: /검수 저장/ }).click();
    await review.getByText('검수를 저장했습니다.').waitFor();
    await label('학습 목표').selectOption('C');
    await button('검수 내용으로 후보 생성 (미승인)').click();
    const card = review.locator('.lab-candidate').first();
    await card.locator(':scope > summary').click();
    await card.getByRole('checkbox').nth(0).check();
    await card.getByRole('checkbox').nth(1).check();
    await card.getByRole('button', { name: '이 후보를 학습용으로 승인', exact: true }).click();
    await card.locator(':scope > summary').filter({ hasText: '승인됨' }).waitFor();
    await button('다음 (J)').click();
  }
  await review.getByText('validation/test 표현군은 학습 후보 생성에서 제외됩니다.').waitFor();
  assert.equal(await button('검수 내용으로 후보 생성 (미승인)').isDisabled(), true);
  await button('1 정답').click();
  await review.getByRole('button', { name: /검수 저장/ }).click();
  await review.getByText('검수를 저장했습니다.').waitFor();
  const panel = page.locator('section.lab-panel').filter({ has: page.getByRole('heading', { name: 'Human Evaluation · 대표 학습 사례 선별', exact: true }) }).last();
  await panel.locator('summary').filter({ hasText: '대표 사례 선택' }).click();
  await panel.locator('fieldset > div > label input[type=checkbox]').nth(0).check();
  await panel.locator('fieldset > div > label input[type=checkbox]').nth(1).check();
  await panel.getByRole('checkbox', { name: '선별 내용·비율을 확인했으며, 선택한 종류의 새 데이터 파일 생성을 승인합니다.', exact: true }).check();
  const downloads = []; page.on('download', download => downloads.push(download));
  await button('승인한 학습 JSONL 생성').click();
  await page.waitForFunction(() => document.body.textContent.includes('데이터 생성 이력 (1)'));
  for (let i = 0; i < 30 && downloads.length < 2; i++) await page.waitForTimeout(100);
  assert.equal(downloads.length, 2);
  const saved = downloads.find(d => d.suggestedFilename().endsWith('.jsonl'));
  const lines = (await readFile(await saved.path(), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.ok(lines.every(line => Object.keys(line).join() === 'messages' && line.messages.at(-1).role === 'assistant'));
  const provenance = JSON.parse(await readFile(await downloads.find(d => d.suggestedFilename().endsWith('.json')).path(), 'utf8'));
  assert.equal(provenance.mock, true);
  assert.equal(provenance.records.length, 2);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile layout must not overflow');
  await page.screenshot({ path: '/tmp/pcu-lab-human-mobile.png', fullPage: true });
  await page.reload();
  await page.getByText('데이터 생성 이력 (1)').waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: blind review, source ratings, train/test gate, explicit approval, balanced selection, JSONL/provenance downloads, mobile and reload persistence');
} finally { await browser?.close(); await vite.close(); }
