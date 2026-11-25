import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { LabResultSchema, LabRunSchema, LabReviewBundleSchema, labDefaultReview, type LabBertScoreResponse } from '@pcu/contracts';
import { buildApp } from '../app.js';
import { createProductionBackendContext } from '../backend-context.js';
import { defaultTestEnv } from './helpers/app-mocks.js';
import { createIsolatedMigratedDatabase } from './helpers/isolated-migrated-database.js';
import { claimCase, finishCase } from '../modules/benchmark-worker/repository.js';
import { claimBertScores, finishBertScore, renewBertLease } from '../modules/benchmark-worker/bertscore-repository.js';
import { processNextBertScores } from '../modules/benchmark-worker/bertscore.js';
import { readLabConfig } from '../modules/benchmark-worker/config.js';
import type { Attempt } from '../modules/benchmark-worker/evaluate.js';

const success: LabBertScoreResponse = { status: 'SUCCEEDED', precision: 0.8, recall: 0.7, f1: 0.7467,
  identity: { model: 'fixture', revision: 'a'.repeat(40), layers: 9, device: 'cpu', threads: 4, batchSize: 4,
    idf: false, rescaleWithBaseline: false, useFastTokenizer: false, maxTokens: 512, versions: { 'bert-score': 'fixture' }, configHash: 'b'.repeat(64) } };
const baseAttempt: Attempt = { output: null, error: null, retryable: false, sources: [], searchCount: 0,
  toolSucceeded: false, toolSupport: 'unsupported', toolCalls: 0, jsonAttempts: 1, outputFormat: 'schema', durationMs: 10 };

describe.runIf(process.env.RUN_POSTGRES_INTEGRATION === 'true')('BERTScore durable queue and authenticated response boundary', () => {
  let database: Awaited<ReturnType<typeof createIsolatedMigratedDatabase>>;
  let db: ReturnType<typeof database.createClient>;
  let app: FastifyInstance;
  const cookies: Record<string, string> = {};
  const origin = 'http://localhost:5173';
  let requestNumber = 0;
  let fixtureUrl: string;
  let mode: 'ok' | 'fail' | 'hold' = 'ok';
  const seen: { candidate: string; reference: string }[][] = [];
  const workers: ChildProcess[] = [];
  const fixture = createServer((req, res) => { void (async () => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const { pairs } = JSON.parse(Buffer.concat(chunks).toString());
    seen.push(pairs);
    if (mode === 'hold') return;
    res.writeHead(mode === 'fail' ? 503 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: pairs.map(() => success) }));
  })().catch(() => { res.writeHead(500); res.end(); }); });
  const config = () => readLabConfig({ LAB_ENABLED: 'true', LAB_MODEL: 'fixture', LAB_BERTSCORE_URL: fixtureUrl });
  async function api(method: 'GET' | 'POST', path: string, payload?: object, status = 200, role = 'BETA_TESTER') {
    const response = await app.inject({ method, url: '/api/lab' + path, payload, remoteAddress: `127.3.${Math.floor(++requestNumber / 250)}.${requestNumber % 250 + 1}`,
      headers: { origin, ...(cookies[role] ? { cookie: cookies[role] } : {}) } });
    expect(response.statusCode, response.body).toBe(status);
    return response.json().data;
  }
  async function queued(size = 1) {
    const cases = Array.from({ length: size }, (_, i) => ({ id: `case-${i}`, nickname: `가상닉네임${i}`,
      reference: { expectedReason: '기대 "근거"\n비공개 기준', expectedScore: 70, scoreRange: [65, 75] } }));
    const dataset = await api('POST', '/datasets', { name: 'BERT fixture', format: 'jsonl', content: cases.map(c => JSON.stringify(c)).join('\n') }, 201);
    const { runId } = await api('POST', '/runs', { datasetId: dataset.id, size, caseIds: cases.map(c => c.id).reverse(),
      systemPrompt: ' 한글\n ', actionPrompt: '', answerPrompt: '\n', model: 'fixture', searchMode: 'no_search', temperature: 0, maxTokens: 256 }, 202);
    return { runId: runId as string, dataset, cases };
  }
  async function generate(reason = '모델 판단 근거', abstained = false, failed = false) {
    const claim = await claimCase(db, 1);
    if (!claim || claim === 'reaped') throw new Error('Missing generation claim');
    expect(JSON.stringify(claim.item)).not.toMatch(/비공개|expectedScore|expectedReason/);
    const outcome = { ...baseAttempt, output: failed ? null : { schemaVersion: '2' as const, nickname: claim.item.input.nickname,
      interpretedTerm: null, reason, score: abstained ? null : 60, confidence: 0.8, sourceIds: [], abstained }, error: failed ? 'PROVIDER_FAILED' : null };
    expect(await finishCase(db, claim, outcome)).toBe(true);
    expect(await finishCase(db, claim, outcome)).toBe(false);
    return claim;
  }
  async function until(predicate: () => Promise<boolean>) {
    for (let i = 0; i < 100; i++) { if (await predicate()) return; await delay(100); }
    throw new Error('Timed out waiting for local worker');
  }
  function startWorker() {
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../benchmark-worker.ts', import.meta.url))], {
      env: { ...process.env, DATABASE_URL: database.url, LAB_ENABLED: 'true', LAB_MODEL: 'fixture',
        LAB_MODEL_PROVIDER: 'ollama', LAB_MODEL_URL: 'http://127.0.0.1:1', LAB_BERTSCORE_URL: fixtureUrl, LAB_CONCURRENCY: '1' },
      stdio: 'ignore',
    });
    workers.push(child); return child;
  }
  beforeAll(async () => {
    database = await createIsolatedMigratedDatabase(process.env.DATABASE_URL!);
    db = database.createClient();
    fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
    fixtureUrl = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
    const context = await createProductionBackendContext({ ...defaultTestEnv, DATABASE_URL: database.url,
      LAB_ENABLED: 'true', LAB_MODEL: 'fixture', LAB_MODEL_URL: 'http://127.0.0.1:1',
      LOG_LEVEL: 'fatal', DEV_AUTH_ENABLED: true, GOOGLE_CLIENT_IDS: ['test-client-id'], CORS_ALLOWED_ORIGINS: [origin] });
    app = await buildApp({ context });
    for (const role of ['BETA_TESTER', 'ADMIN', 'USER']) {
      const login = await app.inject({ method: 'POST', url: '/api/dev/auth/login', headers: { origin }, payload: { role } });
      expect(login.statusCode, login.body).toBe(200);
      cookies[role] = `${login.cookies[0]!.name}=${login.cookies[0]!.value}`;
    }
  }, 60_000);
  afterEach(async () => {
    mode = 'ok';
    for (const child of workers.splice(0)) if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped;
    }
    await db.labBertScore.updateMany({ where: { status: { in: ['RUNNING', 'PENDING'] } }, data: { status: 'CANCELLED', leaseToken: null, leaseUntil: null } });
  });
  afterAll(async () => { await app?.close(); fixture.closeAllConnections(); fixture.close(); await database?.close(); });

  it('serializes empty/populated responses, preserves reviews after scoring, and exports the whole run with matching metrics', async () => {
    expect(await api('GET', '/runs')).toEqual([]);
    const { runId, dataset } = await queued(2);
    const path = `/runs/${runId}`;
    await api('GET', path, undefined, 401, 'anonymous');
    await api('GET', path, undefined, 403, 'USER');
    expect((await api('GET', path + '/results?q=absent')).items).toEqual([]);
    expect(LabRunSchema.parse(await api('GET', path)).bertScore).toMatchObject({ measured: 0, missing: 2, waiting: 2 });
    await generate(); await generate('유보하지만 근거가 있는 응답', true);
    expect(await db.labBertScore.count({ where: { runId } })).toBe(2);
    const before = LabRunSchema.parse(await api('GET', path));
    expect(before).toMatchObject({ status: 'COMPLETED', success: 2, bertScore: { pending: 2, measured: 0 } });
    const item = LabResultSchema.parse((await api('GET', path + '/results')).items[0]);
    const reviewPath = path + `/results/${item.caseId}/review`;
    const bundle = LabReviewBundleSchema.parse(await api('GET', reviewPath));
    expect(bundle.reviews).toEqual([]);
    const body = { ...labDefaultReview(item), verdict: 'correct', cohort: 'normal' };
    await api('POST', reviewPath, { previousReviewId: null, resultHash: bundle.resultHash, body }, 201);
    await processNextBertScores(db, config());
    expect(await processNextBertScores(db, config())).toBe(false);
    const after = LabRunSchema.parse(await api('GET', path));
    expect(after).toMatchObject({ status: 'COMPLETED', success: 2, completedAt: before.completedAt,
      bertScore: { measured: 2, missing: 0, precision: 0.8, recall: 0.7, f1: 0.7467 } });
    expect((await api('GET', reviewPath)).resultHash).toBe(bundle.resultHash);
    const metrics = (await api('GET', path + '/curation?threshold=55')).metrics;
    expect(metrics).toMatchObject({ reviewed: 1, staleReviews: 0, riskThreshold: 55 });
    const json = JSON.parse((await api('GET', path + '/export?format=json&threshold=55')).content);
    expect(json.dataset).toEqual(dataset);
    expect(json.metrics).toEqual(metrics);
    expect(json.results.map((r: { caseId: string }) => r.caseId)).toEqual(['case-1', 'case-0']);
    expect(json.results[0].review).toMatchObject({ valid: true, history: [{ body, valid: true }] });
    const jsonl = (await api('GET', path + '/export?format=jsonl&threshold=55')).content.trim().split('\n').map((s: string) => JSON.parse(s));
    expect(jsonl.map((r: { caseId: string }) => r.caseId)).toEqual(['case-1', 'case-0']);
    expect(jsonl[0]).toMatchObject({ run: json.run, metrics, bertScore: json.results[0].bertScore });
    const csv = (await api('GET', path + '/export?format=csv&threshold=55')).content;
    expect(csv).toContain('bertScorePrecision,bertScoreRecall,bertScoreF1');
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).not.toContain('resultJson');
    await api('GET', path + '/export?format=json&threshold=101', undefined, 400);
    await api('POST', path + '/bertscore/retry', undefined, 403, 'USER');
    await api('POST', path + '/bertscore/retry', undefined, 409);
    const foreign = await api('POST', '/runs', { datasetId: dataset.id, size: 1, model: 'fixture', searchMode: 'no_search', temperature: 0, maxTokens: 256 }, 202, 'ADMIN');
    await api('GET', `/runs/${foreign.runId}/export?format=json`, undefined, 404);
    await api('POST', `/runs/${foreign.runId}/bertscore/retry`, undefined, 404);
    await api('POST', `/runs/${foreign.runId}/cancel`, undefined, 200, 'ADMIN');
    expect(seen.at(-1)).toContainEqual({ candidate: '유보하지만 근거가 있는 응답', reference: '기대 "근거"\n비공개 기준' });
  });

  it('bounds failure retries independently of successful generation, and permits evaluation-only retry', async () => {
    const { runId } = await queued(); await generate();
    mode = 'fail';
    for (let i = 0; i < 3; i++) {
      await db.labBertScore.updateMany({ where: { runId }, data: { nextAttemptAt: new Date(0) } });
      expect(await processNextBertScores(db, config())).toBe(true);
    }
    expect(await db.labResult.findFirstOrThrow({ where: { runId } })).toMatchObject({ status: 'SUCCEEDED', attempts: 1 });
    expect(await db.labBertScore.findFirstOrThrow({ where: { runId } })).toMatchObject({ status: 'FAILED', attempts: 3, reason: 'BERTSCORE_HTTP_503' });
    await api('POST', `/runs/${runId}/bertscore/retry`);
    mode = 'ok'; await processNextBertScores(db, config());
    expect(await db.labBertScore.findFirstOrThrow({ where: { runId } })).toMatchObject({ status: 'SUCCEEDED', attempts: 4, retryBase: 3 });
    await db.labBertScore.updateMany({ where: { runId }, data: { status: 'FAILED', attempts: 12 } });
    await api('POST', `/runs/${runId}/bertscore/retry`, undefined, 409);
  });

  it('fences expired leases, enforces one batch globally and bounds crash-only retries', async () => {
    const { runId } = await queued(2); await generate(); await generate();
    const batches = await Promise.all([claimBertScores(db), claimBertScores(db), claimBertScores(db)]);
    expect(batches.map(b => b.length).sort()).toEqual([0, 0, 2]);
    const old = batches.flat()[0]!;
    expect(await renewBertLease(db, old)).toBe(true);
    await db.labBertScore.updateMany({ where: { runId }, data: { leaseUntil: new Date(0) } });
    expect(await renewBertLease(db, old)).toBe(false);
    const fresh = await claimBertScores(db);
    expect(await finishBertScore(db, old, success)).toBe(false);
    for (const claim of fresh) expect(await finishBertScore(db, claim, success)).toBe(true);
    expect(await finishBertScore(db, fresh[0]!, success)).toBe(false);
    const next = await queued(); await generate();
    for (let i = 0; i < 3; i++) {
      expect(await claimBertScores(db)).toHaveLength(1);
      await db.labBertScore.updateMany({ where: { runId: next.runId }, data: { leaseUntil: new Date(0) } });
    }
    expect(await claimBertScores(db)).toEqual([]);
    expect(await db.labBertScore.findFirstOrThrow({ where: { runId: next.runId } })).toMatchObject({ status: 'FAILED', reason: 'ATTEMPT_LIMIT', attempts: 3 });
  });

  it('preserves cancellation against a late score and records failed/empty generation as unmeasured', async () => {
    const { runId } = await queued(2); await generate();
    const [claim] = await claimBertScores(db);
    await api('POST', `/runs/${runId}/cancel`);
    expect(await renewBertLease(db, claim!)).toBe(false);
    expect(await finishBertScore(db, claim!, success)).toBe(false);
    expect(LabRunSchema.parse(await api('GET', `/runs/${runId}`))).toMatchObject({ status: 'CANCELLED', success: 1, cancelled: 1,
      bertScore: { cancelled: 1, skipped: 1, measured: 0, waiting: 0 } });
    await api('POST', `/runs/${runId}/bertscore/retry`); await processNextBertScores(db, config());
    expect((await api('GET', `/runs/${runId}`)).status).toBe('CANCELLED');
    const next = await queued(2); await generate('   '); await generate('', false, true);
    expect((await db.labBertScore.findMany({ where: { runId: next.runId }, orderBy: { caseId: 'asc' } })).map(r => r.reason).sort())
      .toEqual(['EMPTY_REASON', 'GENERATION_FAILED']);
  });

  it('recovers an interrupted independent worker after restart without repeating generation', async () => {
    const { runId } = await queued(); await generate();
    mode = 'hold'; const beforeRequests = seen.length;
    const first = startWorker();
    await until(async () => seen.length > beforeRequests);
    const exited = once(first, 'exit'); first.kill('SIGKILL'); await exited;
    await db.labBertScore.updateMany({ where: { runId }, data: { leaseUntil: new Date(0) } });
    mode = 'ok'; startWorker();
    await until(async () => (await db.labBertScore.findFirstOrThrow({ where: { runId } })).status === 'SUCCEEDED');
    expect(await db.labBertScore.findFirstOrThrow({ where: { runId } })).toMatchObject({ attempts: 2 });
    expect(await db.labResult.findFirstOrThrow({ where: { runId } })).toMatchObject({ status: 'SUCCEEDED', attempts: 1 });
  });

  it.runIf(!!process.env.TEST_BERTSCORE_URL)('computes actual pinned CPU scores through the queue and authenticated serializers', async () => {
    const { runId } = await queued(); await generate('기대 "근거"\n비공개 기준');
    await processNextBertScores(db, { ...config(), bertScoreUrl: process.env.TEST_BERTSCORE_URL });
    const row = LabResultSchema.parse((await api('GET', `/runs/${runId}/results`)).items[0]);
    expect(row.bertScore?.status).toBe('SUCCEEDED');
    expect(row.bertScore!.f1).toBeGreaterThan(0.99);
    expect(row.bertScore!.identity).toMatchObject({ model: 'google-bert/bert-base-multilingual-cased', layers: 9, device: 'cpu', threads: 4, batchSize: 4 });
  }, 120_000);
});
