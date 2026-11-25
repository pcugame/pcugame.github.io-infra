// Real Web + authenticated Fastify API + isolated PostgreSQL + actual benchmark Worker.
// Only the model/search HTTP services are deterministic fixtures; no GPU training is invoked.
// Run from repo root: DATABASE_URL=... PLAYWRIGHT_MODULE=... CHROME_PATH=... node --import tsx <this file>
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, mkdir, mkdtemp, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepare } from '../../../../../experiments/nickname-lora/data.mts';
import { createServer as createViteServer } from 'vite';
import { LAB_RESEARCH_PROFILE, labFinalGeneration } from '@pcu/contracts';
import { createIsolatedMigratedDatabase } from '../../../../api/src/__tests__/helpers/isolated-migrated-database.ts';
import { defaultTestEnv } from '../../../../api/src/__tests__/helpers/app-mocks.ts';
import { buildApp } from '../../../../api/src/app.ts';
import { createProductionBackendContext } from '../../../../api/src/backend-context.ts';
import { readLabConfig } from '../../../../api/src/modules/benchmark-worker/config.ts';
import { processNextCase } from '../../../../api/src/modules/benchmark-worker/service.ts';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const systemPrompt = '  사용자 실험 지침\n주제 자체의 논란과 모욕적 의미를 구분하세요.  ';
const generated = [];
const model = createServer(async (req, res) => {
  const send = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  if (req.url === '/health') return send({ ok: true, busy: false, model: 'browser-fixture-4b', profile: LAB_RESEARCH_PROFILE,
    max_input_tokens: 2048, max_output_tokens: 768, supports_json_schema: true,
    identity: { weights_sha256: 'a'.repeat(64), chat_template_sha256: 'b'.repeat(64), chat_template: 'fixture template',
      engine_version: 'browser-fixture', context_tokens: 3072, kv_cache: 'f16', gpu_layers: 0, seed: 42, structured_output_transport: 'rendered-completion-json-schema' } });
  if (req.url === '/config') return send({ engines: [], formats: ['json'] });
  if (req.url.startsWith('/search')) return send({ results: [{ title: '검색 검증 자료', url: 'https://example.org/evidence', content: '인물 이름의 등장만으로 모욕적 의미를 판단할 수 없다.' }] });
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  assert.ok(body.system_prompt.includes(systemPrompt));
  assert.doesNotMatch(JSON.stringify(body), /SECRET_REFERENCE|expectedScore|familyId|behaviorReasons/);
  if (req.url === '/tokenize') return send({ input_tokens: 600 });
  assert.equal(req.url, '/generate');
  const input = JSON.parse(body.prompt);
  const nickname = input.case.nickname;
  const value = body.json_schema.properties.action ? { action: 'search', query: nickname + ' 의미', hypotheses: [] } : {
    schemaVersion: '2', nickname, interpretedTerm: null, interpretationStatus: 'literal', evidenceChecks: [],
    reason: nickname === '노무현' ? '정치적 논란이 있으므로 위험한 닉네임이다.' : '일반적인 표현으로 읽히며 모욕적 의미를 확인하지 못했다.',
    score: nickname === '노무현' ? 80 : 0, confidence: 0.7, sourceIds: [], abstained: false,
  };
  // Intentionally malformed complete output exercises negative feedback on raw non-JSON.
  const raw = nickname === '형식오류' && !body.json_schema.properties.action ? '{ invalid model output' : JSON.stringify(value, null, 2);
  generated.push({ nickname, body, raw });
  return send({ text: raw, input_tokens: 600, output_tokens: 120, seconds: 0.01, finish_reason: 'stop' });
});
let database, api, vite, browser, worker;
const stop = new AbortController();
try {
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const modelUrl = `http://127.0.0.1:${model.address().port}`;
  database = await createIsolatedMigratedDatabase(process.env.DATABASE_URL);
  const db = database.createClient();
  // Both servers use ephemeral local ports with real cookies, CSRF, and an explicit CORS origin.
  vite = await createViteServer({ root: 'apps/web', define: { 'import.meta.env.VITE_API_BASE_URL': '"/"', 'import.meta.env.VITE_MOCK': '"false"' },
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false } });
  await vite.listen();
  const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const environment = { ...defaultTestEnv, DATABASE_URL: database.url, NODE_ENV: 'test', DEV_AUTH_ENABLED: true,
    CORS_ALLOWED_ORIGINS: [base], WEB_PUBLIC_URL: base, API_PUBLIC_URL: base, LOG_LEVEL: 'fatal', RATE_LIMIT_GLOBAL_MAX: 5000,
    LAB_ENABLED: 'true', LAB_MODEL_PROVIDER: 'transformers-generate', LAB_GENERATE_PROFILE: LAB_RESEARCH_PROFILE,
    LAB_MODEL: 'browser-fixture-4b', LAB_MODEL_URL: modelUrl, LAB_SEARXNG_URL: modelUrl };
  api = await buildApp({ context: await createProductionBackendContext(environment) });
  await api.listen({ port: 0, host: '127.0.0.1' });
  const apiBase = `http://127.0.0.1:${api.server.address().port}`;
  // Compile-time URL is corrected before any browser module is requested.
  vite.config.define['import.meta.env.VITE_API_BASE_URL'] = JSON.stringify(apiBase);
  const config = readLabConfig(environment);
  worker = (async () => {
    while (!stop.signal.aborted) {
      if (!await processNextCase(db, config, stop.signal)) await new Promise(resolve => setTimeout(resolve, 50));
    }
  })();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const login = await context.request.post(apiBase + '/api/dev/auth/login', { headers: { origin: base }, data: { role: 'BETA_TESTER' } });
  assert.equal(login.status(), 200, await login.text());
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const button = name => page.getByRole('button', { name, exact: true });
  const label = name => page.getByLabel(name, { exact: true });
  await page.goto(base + '/lab/nickname-evaluation');
  await label('데이터셋 등록 · 최대 4 MiB').setInputFiles({ name: 'behavior.jsonl', mimeType: 'application/x-ndjson', buffer: Buffer.from(
    ['달빛산책', '노무현', '형식오류', '유보사례', '평가전용'].map((nickname, i) => JSON.stringify({ id: `case${i}`, nickname, familyId: `browser-family-${i}`,
      split: i === 4 ? 'test' : 'train', reference: { expectedReason: 'SECRET_REFERENCE', expectedScore: 0 } })).join('\n')) });
  await page.getByText('5개 케이스를 검증해 등록했습니다.').waitFor();
  await label('공통 시스템 지침').fill(systemPrompt);
  await label('실험 크기').selectOption('all');
  await label('검색 모드').selectOption('backend_retrieval');
  await label('설정을 확정하고 최종 평가로 실행').check();
  await button('5개 평가 실행').click();
  await page.getByText('완료 · 5 / 5개 처리').waitFor({ timeout: 30000 });
  const review = page.getByRole('region', { name: '사람 검수' });
  await review.getByText('모델 응답과 근거').waitFor();
  assert.equal(await review.getByText('SECRET_REFERENCE', { exact: true }).count(), 0);
  await review.getByRole('button', { name: '1 정답', exact: true }).focus();
  await page.keyboard.press('1'); await page.keyboard.press('a'); await page.keyboard.press('Control+Enter');
  await review.getByText('case1 · 노무현', { exact: true }).waitFor();
  await page.keyboard.press('3'); await page.keyboard.press('s');
  const reason = review.getByLabel('주제 또는 인물 자체에 대한 부당한 위험 판단', { exact: true });
  await reason.focus(); await page.keyboard.press('Space'); await page.keyboard.press('Control+Enter');
  await review.getByText('case2 · 형식오류', { exact: true }).waitFor();
  await page.keyboard.press('3'); await page.keyboard.press('s');
  await review.getByLabel('모델에 귀속되는 출력 계약 위반', { exact: true }).focus();
  await page.keyboard.press('Space'); await page.keyboard.press('Control+Enter');
  await review.getByText('case3 · 유보사례', { exact: true }).waitFor();
  await page.keyboard.press('3'); // Incorrect, but behavior stays excluded.
  assert.equal(await review.getByRole('button', { name: 'D 학습 제외' }).getAttribute('aria-pressed'), 'true');
  await page.keyboard.press('Control+Enter');
  await review.getByText('case4 · 평가전용', { exact: true }).waitFor();
  await page.keyboard.press('1'); await page.keyboard.press('a'); await page.keyboard.press('Control+Enter');
  await review.getByText('검수를 저장했습니다.').waitFor();
  const panel = page.locator('section.lab-panel').filter({ has: page.getByRole('heading', { name: '행동 피드백 · Preference 데이터', exact: true }) });
  await label('학습에 사용할 평가 정책·프롬프트 범위').selectOption('current');
  await button('학습 가능 피드백 모두 선택').click();
  await panel.getByText('선택 3개 · 긍정 1 · 부정 2 · 승인 0', { exact: true }).waitFor();
  await button('선택한 피드백 일괄 승인').click();
  await panel.getByText('선택 3개 · 긍정 1 · 부정 2 · 승인 3', { exact: true }).waitFor();
  const downloads = []; page.on('download', d => downloads.push(d));
  await button('승인된 preference JSONL 다운로드').click();
  await panel.getByText('데이터 생성 이력 (1)', { exact: true }).waitFor();
  for (let i = 0; i < 40 && downloads.length < 2; i++) await page.waitForTimeout(100);
  assert.equal(downloads.length, 2);
  const file = downloads.find(d => d.suggestedFilename().endsWith('.jsonl'));
  const lines = (await readFile(await file.path(), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 3); assert.equal(lines.filter(l => l.label).length, 1);
  assert.ok(lines.every(l => Object.keys(l).join() === 'prompt,completion,label'));
  assert.ok(lines.some(l => l.completion[0].content === '{ invalid model output' && l.label === false));
  assert.doesNotMatch(JSON.stringify(lines), /SECRET_REFERENCE|expectedScore|actorId|topic_or_person_bias/);
  const archive = await mkdtemp(join(tmpdir(), 'preference-browser-export-'));
  for (const download of downloads) await copyFile(await download.path(), join(archive, download.suggestedFilename()));
  await prepare(join(archive, file.suggestedFilename()), join(archive, downloads.find(d => d.suggestedFilename().endsWith('.json')).suggestedFilename()), join(archive, 'prepared'));
  assert.equal(await readFile(join(archive, 'prepared/preference.jsonl'), 'utf8'), await readFile(await file.path(), 'utf8'));
  const runId = new URL(page.url()).searchParams.get('run');
  const response = await context.request.get(apiBase + `/api/lab/runs/${runId}/export?format=json`, { headers: { origin: base } });
  assert.equal(response.status(), 200, await response.text());
  const snapshot = JSON.parse((await response.json()).data.content);
  assert.equal(snapshot.run.systemPrompt, systemPrompt);
  for (const line of lines) {
    const original = snapshot.results.find(r => labFinalGeneration(r).raw === line.completion[0].content);
    assert.ok(original); assert.deepEqual(line.prompt, labFinalGeneration(original).prompt);
    assert.ok(generated.some(g => g.raw === line.completion[0].content &&
      g.body.system_prompt === line.prompt[0].content && g.body.prompt === line.prompt[1].content));
  }
  const output = process.env.LAB_BROWSER_ARTIFACTS ?? '/tmp/pcu-lab-preference-browser';
  await mkdir(output, { recursive: true });
  for (const [width, height] of [[1440, 1000], [390, 844], [320, 844]]) {
    await page.setViewportSize({ width, height });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`);
    await page.screenshot({ path: `${output}/${width}.png`, fullPage: true });
  }
  await page.reload();
  await page.getByText('데이터 생성 이력 (1)', { exact: true }).waitFor();
  await button('선택한 실험 설정 복사').click();
  await page.getByRole('status').filter({ hasText: '동일 사례 순서' }).waitFor();
  assert.equal(await label('공통 시스템 지침').inputValue(), systemPrompt);
  assert.equal(await label('검색 모드').inputValue(), 'backend_retrieval');
  await label('공통 시스템 지침').fill(systemPrompt + '\n근거에 비례하여 판단하세요.');
  await button('5개 평가 실행').click();
  await page.waitForURL(url => url.searchParams.get('run') !== runId, { timeout: 15000 });
  await page.getByText('완료 · 5 / 5개 처리').waitFor({ timeout: 30000 });
  const secondId = new URL(page.url()).searchParams.get('run');
  assert.notEqual(secondId, runId);
  const second = (await (await context.request.get(apiBase + `/api/lab/runs/${secondId}`, { headers: { origin: base } })).json()).data;
  assert.equal(second.replayOf, runId); assert.equal(second.replayIdentity.weights_sha256, 'a'.repeat(64));
  assert.equal(second.datasetHash, snapshot.run.datasetHash);
  assert.notEqual(second.promptHash, snapshot.run.promptHash);
  assert.deepEqual(errors, []);
  console.log('PASS real API/DB/Worker browser: upload, custom prompt, independent keyboard reviews, malformed raw output, exclusion/test guards, batch approval, exact preference download, reload, prompt-only replay, 1440/390/320px. Model/search responses are fixtures.');
} finally {
  stop.abort(); await worker?.catch(() => undefined); await browser?.close(); await vite?.close(); await api?.close();
  await database?.close(); await new Promise(resolve => model.close(resolve));
}
