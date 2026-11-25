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
        history: [{ event: 'finished', generationContexts: [{ stage: 'answer', messages: [{ role: 'system', content: 'fixture policy' }, { role: 'user', content: JSON.stringify({ nickname: c.nickname, sources: [] }) }], suppliedSources: [], durationMs: 10 }], searchDurationMs: 0, generationDurationMs: 10, output }] } });
    }
    await db.labRun.update({ where: { id: runId }, data: { status: 'COMPLETED', completedAt: new Date() } });
  }, 60_000);
  afterAll(async () => { await app?.close(); await database?.close(); });
  it('preserves original responses, versions reviews and requires grounded approval before actual JSONL export', async () => {
    const base = `/runs/${runId}`;
    expect(LabCurationOverviewSchema.parse(await api('GET', base + '/curation'))).toMatchObject({ candidates: [], exports: [], metrics: { total: 5, reviewed: 0, failed: 1 } });
    const results = (await api('GET', base + '/results')).items.map((r: unknown) => LabResultSchema.parse(r));
    const ids: string[] = [];
    for (const caseId of ['normal', 'error', 'heldout', 'validation', 'failure']) {
      const path = `${base}/results/${caseId}`;
      const bundle = LabReviewBundleSchema.parse(await api('GET', path + '/review'));
      expect(bundle.reviews).toEqual([]);
      const item = results.find((r: { caseId: string }) => r.caseId === caseId)!;
      const body = { ...labDefaultReview(item), verdict: caseId === 'failure' ? 'deferred' : caseId === 'error' ? 'incorrect' : 'correct', errors: caseId === 'error' ? ['score'] : [],
        cause: caseId === 'error' ? 'model' : 'none', cohort: caseId === 'error' ? 'problematic' : 'normal', rationaleFit: caseId !== 'error', interpretationSuccess: true,
        correction: caseId === 'error' ? { reason: '사람이 교정한 근거', score: 80 } : {} };
      const review = await api('POST', path + '/review', { previousReviewId: null, resultHash: bundle.resultHash, body }, 201);
      await api('POST', path + '/review', { previousReviewId: null, resultHash: bundle.resultHash, body }, 409);
      const eligible = ['normal', 'error'].includes(caseId);
      const raw = await api('POST', path + '/candidates', { reviewId: review.id, objective: 'C' }, eligible ? 201 : 400);
      if (!eligible) continue;
      const candidate = LabCandidateSchema.parse(raw);
      ids.push(candidate.id);
      expect(candidate).toMatchObject({ status: 'draft', stale: false, decisions: [] });
      expect(candidate.body.messages[1]!.content).not.toContain('원본 기대 근거');
      await api('POST', `${base}/candidates/${candidate.id}/decision`, { decision: 'approved', contentHash: candidate.contentHash, grounded: false, familyVerified: true }, 400);
      await api('POST', base + '/curation/exports', { kind: 'train', candidateIds: ids, policy: {}, approved: true }, 400);
      const approved = LabCandidateSchema.parse(await api('POST', `${base}/candidates/${candidate.id}/decision`, { decision: 'approved', contentHash: candidate.contentHash, grounded: true, familyVerified: true }));
      expect(approved.decisions).toHaveLength(1);
      expect((await db.labResult.findUniqueOrThrow({ where: { runId_caseId: { runId, caseId } } })).output).toMatchObject({ reason: '모델 원본 판단', score: 0 });
    }
    await api('POST', base + '/curation/exports', { kind: 'train', candidateIds: ids, policy: {}, approved: false }, 400);
    const exported = LabCurationExportSchema.parse(await api('POST', base + '/curation/exports', { kind: 'train', candidateIds: ids, policy: LabCurationPolicySchema.parse({ minAmbiguousShare: 0 }), approved: true }, 201));
    const lines = exported.files[0]!.content.trim().split('\n').map(line => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(Object.keys(lines[0])).toEqual(['messages']);
    expect(lines[1].messages.at(-1).content).toContain('사람이 교정한 근거');
    expect(exported.files[1]!.content).toContain('모델 원본 판단');
    expect(exported.files[1]!.content).toContain('contentHash');
    expect((await api('GET', `${base}/curation/exports/${exported.id}`)).files).toEqual(exported.files);
    for (const kind of ['validation', 'test']) {
      const file = LabCurationExportSchema.parse(await api('POST', base + '/curation/exports', { kind, policy: {}, approved: true }, 201));
      expect(file.files[0]!.content).toContain('evaluation_only');
      expect(file.files[0]!.content).toContain('원본 기대 근거');
      expect(JSON.parse(file.files[0]!.content).messages).toBeUndefined();
    }
    const old = LabReviewBundleSchema.parse(await api('GET', base + '/results/normal/review'));
    await api('POST', base + '/results/normal/review', { previousReviewId: old.reviews[0]!.id, resultHash: old.resultHash, body: { ...old.reviews[0]!.body, notes: '재검수' } }, 201);
    expect((await api('GET', base + '/results/normal/review')).candidates[0].stale).toBe(true);
    await api('POST', base + '/curation/exports', { kind: 'train', candidateIds: ids, policy: {}, approved: true }, 400);
    // Old release files remain immutable and downloadable with their original approvals.
    expect((await api('GET', `${base}/curation/exports/${exported.id}`)).files).toEqual(exported.files);
    await db.labResult.update({ where: { runId_caseId: { runId, caseId: 'error' } }, data: { attempts: 2 } });
    expect((await api('GET', base + '/curation')).metrics.staleReviews).toBe(1);
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
    await api('POST', path + '/candidates', { reviewId: review.reviews[0]!.id, objective: 'C' }, 201);
  });

  it('preserves unclassified cohorts as null through authenticated review serialization', async () => {
    const path = `/runs/${runId}/results/normal/review`;
    const bundle = LabReviewBundleSchema.parse(await api('GET', path));
    const saved = await api('POST', path, { previousReviewId: bundle.reviews[0]!.id, resultHash: bundle.resultHash,
      body: { ...bundle.reviews[0]!.body, cohort: null } }, 201);
    expect(saved.body.cohort).toBeNull();
    expect((await api('GET', `/runs/${runId}/curation`)).metrics.unknownCohort).toBe(2);
  });

});
