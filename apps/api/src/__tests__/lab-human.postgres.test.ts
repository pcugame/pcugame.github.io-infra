import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { labDefaultReview, LabResultSchema, LabReviewBundleSchema, LabCandidateSchema, LabCurationExportSchema, LabCurationPolicySchema, LabCurationOverviewSchema } from '@pcu/contracts';
import { buildApp } from '../app.js';
import { createProductionBackendContext } from '../backend-context.js';
import { createIsolatedMigratedDatabase } from './helpers/isolated-migrated-database.js';
import { defaultTestEnv } from './helpers/app-mocks.js';

describe.runIf(process.env.RUN_POSTGRES_INTEGRATION === 'true')('Human Evaluation authenticated PostgreSQL boundaries', () => {
  let database: Awaited<ReturnType<typeof createIsolatedMigratedDatabase>>;
  let app: FastifyInstance;
  let cookie: string;
  let runId: string;
  let db: ReturnType<typeof database.createClient>;
  let requestNumber = 0;
  async function api(method: 'GET' | 'POST', path: string, payload?: object, status = 200, auth = cookie) {
    const response = await app.inject({ method, url: '/api/lab' + path, payload, remoteAddress: `127.0.1.${++requestNumber}`, headers: { origin: 'http://localhost:5173', cookie: auth } });
    expect(response.statusCode, response.body).toBe(status);
    return response.json().data;
  }
  beforeAll(async () => {
    database = await createIsolatedMigratedDatabase(process.env.DATABASE_URL!);
    db = database.createClient();
    const context = await createProductionBackendContext({ ...defaultTestEnv, DATABASE_URL: database.url,
      LAB_ENABLED: 'true', LAB_MODEL: 'fixture', LAB_MODEL_URL: 'http://127.0.0.1:1', LAB_SEARXNG_URL: 'http://127.0.0.1:1',
      LOG_LEVEL: 'fatal', DEV_AUTH_ENABLED: true, GOOGLE_CLIENT_IDS: ['test-client-id'], CORS_ALLOWED_ORIGINS: ['http://localhost:5173'] });
    app = await buildApp({ context });
    const login = await app.inject({ method: 'POST', url: '/api/dev/auth/login', headers: { origin: 'http://localhost:5173' }, payload: { role: 'BETA_TESTER' } });
    expect(login.statusCode, login.body).toBe(200);
    cookie = `${login.cookies[0]!.name}=${login.cookies[0]!.value}`;
    const cases = ['normal', 'error', 'heldout', 'validation', 'failure'].map((id, i) => ({ id, nickname: `닉네임${i}`, familyId: id,
      split: id === 'heldout' ? 'test' : id === 'validation' ? 'validation' : 'train', reference: { expectedReason: '원본 기대 근거', expectedScore: i === 1 ? 80 : 0 } }));
    const dataset = await api('POST', '/datasets', { name: 'human fixture', format: 'jsonl', content: cases.map(c => JSON.stringify(c)).join('\n') }, 201);
    await api('POST', '/runs', { datasetId: dataset.id, size: 5, model: 'fixture', searchMode: 'no_search', temperature: 0, maxTokens: 256 }, 400);
    runId = (await api('POST', '/runs', { datasetId: dataset.id, size: 5, finalTest: true, model: 'fixture', searchMode: 'no_search', temperature: 0, maxTokens: 256 }, 202)).runId;
    for (const c of cases) {
      const output = { schemaVersion: '2', nickname: c.nickname, interpretedTerm: null, reason: '모델 원본 판단', score: 0, confidence: 0.8, sourceIds: [], abstained: false };
      const failed = c.id === 'failure';
      await db.labResult.update({ where: { runId_caseId: { runId, caseId: c.id } }, data: { status: failed ? 'FAILED' : 'SUCCEEDED', output: failed ? undefined : output,
        error: failed ? 'PROVIDER_UNREACHABLE' : null, attempts: 1, jsonValid: !failed, durationMs: 10,
        history: [{ event: 'finished', generationContexts: [{ stage: 'answer', messages: [{ role: 'system', content: 'fixture policy' }, { role: 'user', content: JSON.stringify({ nickname: c.nickname, sources: [] }) }], suppliedSources: [], durationMs: 10, rawResponse: JSON.stringify(JSON.stringify(output)), rawResponseEncoding: 'json-string', finishReason: 'stop', validation: { valid: true, error: null } }], searchDurationMs: 0, generationDurationMs: 10, output }] } });
    }
    await db.labRun.update({ where: { id: runId }, data: { status: 'COMPLETED', completedAt: new Date() } });
  }, 60_000);
  afterAll(async () => { await app?.close(); await database?.close(); });
  it('saves independent axes, atomically approves selected feedback and exports original unpaired completions', async () => {
    const base = `/runs/${runId}`;
    const empty = LabCurationOverviewSchema.parse(await api('GET', base + '/curation'));
    expect(empty).toMatchObject({ feedback: [], candidates: [], exports: [], metrics: { total: 5, reviewed: 0, failed: 1 } });
    const scope = empty.scope!;
    const results = (await api('GET', base + '/results')).items.map((r: unknown) => LabResultSchema.parse(r));
    const reviewIds: string[] = [];
    let heldout = '';
    for (const caseId of ['normal', 'error', 'heldout', 'validation', 'failure']) {
      const path = `${base}/results/${caseId}`;
      const bundle = LabReviewBundleSchema.parse(await api('GET', path + '/review'));
      const item = results.find((r: { caseId: string }) => r.caseId === caseId)!;
      const body = { ...labDefaultReview(item), verdict: caseId === 'failure' ? 'incorrect' : caseId === 'error' ? 'partial' : 'correct',
        behavior: caseId === 'failure' ? 'exclude' : caseId === 'error' ? 'negative' : 'positive',
        behaviorReasons: caseId === 'error' ? ['fabricated_fact'] : [] };
      const review = await api('POST', path + '/review', { previousReviewId: null, resultHash: bundle.resultHash, body }, 201);
      expect(review.body.verdict).toBe(body.verdict); expect(review.body.behavior).toBe(body.behavior);
      await api('POST', path + '/review', { previousReviewId: null, resultHash: bundle.resultHash, body }, 409);
      if (caseId === 'heldout') heldout = review.id;
      if (['normal', 'error'].includes(caseId)) reviewIds.push(review.id);
    }
    await api('POST', base + '/feedback/approve', { reviewIds: [...reviewIds, heldout], scope }, 400);
    expect(await db.labTrainingCandidate.count()).toBe(0); // Whole batch is atomic.
    await api('POST', base + '/feedback/approve', { reviewIds, scope: { ...scope, feedbackPolicy: 'another policy' } }, 400);
    const approved = (await api('POST', base + '/feedback/approve', { reviewIds, scope })).map((v: unknown) => LabCandidateSchema.parse(v));
    const ids = approved.map((c: { id: string }) => c.id);
    expect(approved).toHaveLength(2);
    expect(approved[0]).toMatchObject({ status: 'approved', stale: false, body: { version: 'preference-v1', label: true } });
    expect((await api('POST', base + '/feedback/approve', { reviewIds, scope })).map((c: { id: string }) => c.id)).toEqual(ids);
    expect(await db.labTrainingCandidate.count()).toBe(2);
    const request = { kind: 'train', candidateIds: ids, scope, policy: LabCurationPolicySchema.parse({}), approved: true };
    await api('POST', base + '/curation/exports', { ...request, approved: false }, 400);
    await api('POST', base + '/curation/exports', { ...request, scope: { ...scope, promptHash: 'b'.repeat(64) } }, 400);
    const exported = LabCurationExportSchema.parse(await api('POST', base + '/curation/exports', request, 201));
    const lines = exported.files[0]!.content.trim().split('\n').map(line => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines.map(v => Object.keys(v))).toEqual([['prompt', 'completion', 'label'], ['prompt', 'completion', 'label']]);
    expect(lines.map(v => v.label)).toEqual([true, false]);
    expect(lines[1].completion[0].content).toContain('모델 원본 판단');
    expect(exported.files[0]!.content).not.toMatch(/원본 기대 근거|expectedScore|actorId|fabricated_fact/);
    expect(exported.manifest.selection).toMatchObject({ positive: 1, negative: 1 });
    expect((await api('GET', `${base}/curation/exports/${exported.id}`)).files).toEqual(exported.files);
    for (const kind of ['validation', 'test']) {
      const file = LabCurationExportSchema.parse(await api('POST', base + '/curation/exports', { ...request, kind, candidateIds: [] }, 201));
      expect(file.files[0]!.content).toContain('evaluation_only'); expect(file.files[0]!.content).toContain('원본 기대 근거');
      expect(JSON.parse(file.files[0]!.content).prompt).toBeUndefined();
    }
    const old = LabReviewBundleSchema.parse(await api('GET', base + '/results/normal/review'));
    await api('POST', base + '/results/normal/review', { previousReviewId: old.reviews[0]!.id, resultHash: old.resultHash, body: { ...old.reviews[0]!.body, notes: '재검수' } }, 201);
    expect((await api('GET', base + '/results/normal/review')).candidates[0].stale).toBe(true);
    await api('POST', base + '/curation/exports', request, 400);
    await api('POST', base + '/feedback/approve', { reviewIds, scope }, 409);
    expect((await api('GET', `${base}/curation/exports/${exported.id}`)).files).toEqual(exported.files);
    await db.labResult.update({ where: { runId_caseId: { runId, caseId: 'error' } }, data: { attempts: 2 } });
    expect((await api('GET', base + '/curation')).metrics.staleReviews).toBe(1);
  });
  it('clones exact dataset/cases/settings and records prompt-only experiments without editing source history', async () => {
    const original = await api('GET', `/runs/${runId}`);
    const ids = ['normal', 'error', 'heldout', 'validation', 'failure'];
    const input = { replayOf: runId, datasetId: original.datasetId, size: 5, caseIds: ids, finalTest: true,
      model: original.model, searchMode: original.searchMode, temperature: original.temperature, maxTokens: original.maxTokens,
      systemPrompt: '새 프롬프트', actionPrompt: original.actionPrompt, answerPrompt: original.answerPrompt };
    await api('POST', '/runs', { ...input, caseIds: [...ids].reverse() }, 400);
    await api('POST', '/runs', { ...input, temperature: 0.5 }, 400);
    const replay = await api('POST', '/runs', input, 202);
    const saved = await api('GET', `/runs/${replay.runId}`);
    expect(saved).toMatchObject({ replayOf: runId, systemPrompt: '새 프롬프트', datasetHash: original.datasetHash });
    expect((await api('GET', `/runs/${runId}`)).systemPrompt).toBe(original.systemPrompt);
    await api('POST', `/runs/${replay.runId}/cancel`);
  });
  it('protects ownership and rejects cross-dataset family or nickname leakage', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/dev/auth/login', headers: { origin: 'http://localhost:5173' }, payload: { role: 'USER' } });
    const other = `${login.cookies[0]!.name}=${login.cookies[0]!.value}`;
    await api('GET', `/runs/${runId}/curation`, undefined, 403, other);
    await db.user.update({ where: { id: login.json().data.user.id }, data: { role: 'BETA_TESTER' } });
    await api('GET', `/runs/${runId}/curation`, undefined, 404, other);
    await api('GET', `/runs/${runId}/results/normal/review`, undefined, 404, other);
    await api('GET', `/runs/${runId}/results/normal/review`, undefined, 401, '');
    for (const body of [
      { nickname: '또다른변형', familyId: ' HELDOUT ', split: 'train' },
      { nickname: '닉네임2', familyId: 'renamed-heldout', split: 'train' },
    ]) await api('POST', '/datasets', { name: 'leakage', format: 'jsonl', content: JSON.stringify({ ...body, reference: { expectedReason: '기대', expectedScore: 0 } }) }, 400);
    expect(await db.labDataset.count()).toBe(1);
  });
  it('isolates conflicting legacy families without blocking unrelated reviewed cases', async () => {
    const run = await db.labRun.findUniqueOrThrow({ where: { id: runId } });
    for (const split of ['train', 'test']) {
      const body = { id: 'legacy', nickname: 'legacy-' + split, familyId: 'legacy-conflict', split, reference: { expectedReason: '기대', expectedScore: 0 } };
      await db.labDataset.create({ data: { ownerId: run.ownerId, name: 'legacy', hash: 'legacy-' + split, count: 1,
        cases: { create: { caseId: body.id, ordinal: 0, nickname: body.nickname, familyId: body.familyId, split, body } } } });
    }
    const path = `/runs/${runId}/results/normal`;
    const review = LabReviewBundleSchema.parse(await api('GET', path + '/review'));
    expect(review.splitError).toBeNull();
    expect(review.effectiveSplit).toBe('train');
    await api('POST', `/runs/${runId}/feedback/approve`, { reviewIds: [review.reviews[0]!.id], scope: (await api('GET', `/runs/${runId}/curation`)).scope });
  });

  it('preserves unclassified cohorts as null through authenticated review serialization', async () => {
    const path = `/runs/${runId}/results/normal/review`;
    const bundle = LabReviewBundleSchema.parse(await api('GET', path));
    const saved = await api('POST', path, { previousReviewId: bundle.reviews[0]!.id, resultHash: bundle.resultHash,
      body: { ...bundle.reviews[0]!.body, cohort: null } }, 201);
    expect(saved.body.cohort).toBeNull();
    expect((await api('GET', `/runs/${runId}/curation`)).metrics.unknownCohort).toBe(5);
  });

});
