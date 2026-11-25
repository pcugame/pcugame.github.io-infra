import { labReviewResult, LabSaveReviewSchema, LabApproveFeedbackSchema, LabCurationExportRequestSchema,
  labBuildPreference, labPreferenceScope, labAssertPreferenceScope, labFamilyPlan, labFamilyKey, labHumanMetrics, labValidateSelection, labTrainingLine, labEvaluationLine,
  type LabHumanReview, type LabCandidate, type LabCurationExport, type LabResult, type LabRun, type LabCase,
} from '@pcu/contracts';
import { allowMethod, bodyObject, conflict, missing, parseInput } from './common';
import { MockHttpError, UNHANDLED, type MockRequestOptions } from './context';

export type MockHumanState = { reviews: (LabHumanReview & { resultSnapshot: LabResult })[]; candidates: LabCandidate[];
  exports: LabCurationExport[]; families: Record<string, 'train' | 'validation' | 'test'> };
export async function labMockHash(value: unknown) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
function validate<T>(fn: () => T): T { try { return fn(); } catch (e) { throw new MockHttpError(400, 'VALIDATION_ERROR', e instanceof Error ? e.message : 'Invalid curation input'); } }
export async function handleLabHuman(state: MockHumanState, actorId: number, run: { info: LabRun; rows: LabResult[] }, allCases: LabCase[],
  pathname: string, method: string, options: MockRequestOptions, threshold: number) {
  const runId = run.info.id;
  const latest = (caseId: string) => state.reviews.find(r => r.runId === runId && r.caseId === caseId);
  const hashes = new Map(await Promise.all(run.rows.map(async r => [r.caseId, await labMockHash(labReviewResult(r))] as const)));
  const row = (caseId: string) => run.rows.find(r => r.caseId === caseId) ?? missing('Result not found');
  const plan = () => validate(() => labFamilyPlan(allCases, state.families));
  const fresh = (candidate: LabCandidate) => ({ ...candidate, stale: latest(candidate.caseId)?.id !== candidate.reviewId || latest(candidate.caseId)?.resultHash !== hashes.get(candidate.caseId) });
  const candidates = () => state.candidates.filter(c => c.runId === runId).map(fresh);
  const resultPath = /\/results\/([^/]+)\/(review)$/.exec(pathname);
  if (resultPath) {
    const caseId = decodeURIComponent(resultPath[1]);
    const result = row(caseId);
    const previous = latest(caseId);
    if (resultPath[2] === 'review') {
      allowMethod(method, 'GET', 'POST');
      if (method === 'GET') return { resultHash: hashes.get(caseId), reviews: state.reviews.filter(r => r.runId === runId && r.caseId === caseId),
        candidates: candidates().filter(c => c.caseId === caseId), effectiveSplit: result.testCase.familyId ? plan()[labFamilyKey(result.testCase.familyId)] : null, splitError: null };
      const input = parseInput(LabSaveReviewSchema, bodyObject(options));
      if (input.previousReviewId !== (previous?.id ?? null) || input.resultHash !== hashes.get(caseId) || !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(result.status)) conflict('최신 결과를 다시 불러오세요.');
      if (input.body.verdict === 'correct' && (result.status !== 'SUCCEEDED' || !result.output || !result.jsonValid)) throw new MockHttpError(400, 'VALIDATION_ERROR', '유효한 성공 응답만 정답으로 평가할 수 있습니다.');
      if (new Set(input.body.sourceChecks.map(c => c.sourceId)).size !== input.body.sourceChecks.length || input.body.sourceChecks.some(c => !result.output?.sourceIds.includes(c.sourceId))) throw new MockHttpError(400, 'VALIDATION_ERROR', '실제로 인용한 출처만 평가하세요.');
      const review = { id: crypto.randomUUID(), runId, caseId, revision: (previous?.revision ?? 0) + 1, actorId, createdAt: new Date().toISOString(), resultHash: input.resultHash, body: input.body, resultSnapshot: structuredClone(result) };
      state.reviews.unshift(review); return review;
    }
  }
  if (pathname.endsWith('/feedback/approve')) {
    allowMethod(method, 'POST');
    const input = parseInput(LabApproveFeedbackSchema, bodyObject(options));
    validate(() => labAssertPreferenceScope(labPreferenceScope(run.info), input.scope));
    const groups = plan();
    // Validate the entire batch before mutating persistent state.
    const prepared = input.reviewIds.map(id => {
      const review = state.reviews.find(r => r.id === id && r.runId === runId);
      if (!review || latest(review.caseId)?.id !== id || review.resultHash !== hashes.get(review.caseId)) conflict('최신 검수를 다시 선택하세요.');
      const result = row(review!.caseId);
      return { review: review!, body: validate(() => labBuildPreference(result, review!.body, groups[labFamilyKey(result.testCase.familyId ?? '')] ?? null, input.scope)) };
    });
    const approved: LabCandidate[] = [];
    for (const { review, body } of prepared) {
      const existing = candidates().find(c => c.reviewId === review.id && c.body.version === 'preference-v1' && c.status === 'approved' && !c.stale);
      if (existing) { approved.push(existing); continue; }
      const candidate: LabCandidate = { id: crypto.randomUUID(), reviewId: review.id, runId, caseId: review.caseId, actorId,
        createdAt: new Date().toISOString(), contentHash: await labMockHash(body), status: 'approved', body,
        decisions: [{ actorId, at: new Date().toISOString(), decision: 'approved', grounded: true, familyVerified: true }], stale: false };
      state.candidates.unshift(candidate); approved.push(candidate);
    }
    state.families = groups;
    return approved;
  }
  const valid = new Map(run.rows.flatMap(r => { const review = latest(r.caseId); return review?.resultHash === hashes.get(r.caseId) ? [[r.caseId, review!.body] as const] : []; }));
  if (pathname.endsWith('/curation')) {
    allowMethod(method, 'GET');
    const currentCount = run.rows.filter(r => latest(r.caseId)).length;
    const scope = labPreferenceScope(run.info);
    const groups = plan();
    const feedback = run.rows.flatMap(result => {
      const review = latest(result.caseId);
      if (!review) return [];
      let exclusion: string | null = null;
      try {
        if (!valid.has(result.caseId)) throw new Error('결과가 변경되었습니다. 재검수하세요.');
        labBuildPreference(result, review.body, groups[labFamilyKey(result.testCase.familyId ?? '')] ?? null, scope);
      } catch (e) { exclusion = e instanceof Error ? e.message : 'Invalid feedback'; }
      return [{ review, nickname: result.testCase.nickname, familyId: result.testCase.familyId ?? null, eligible: !exclusion, exclusion,
        candidateId: candidates().find(c => c.reviewId === review.id && c.body.version === 'preference-v1' && c.status === 'approved' && !c.stale)?.id ?? null }];
    });
    return { scope, feedback, metrics: labHumanMetrics(run.rows, valid, threshold, currentCount - valid.size), candidates: candidates(), exports: state.exports.filter(e => e.runId === runId).map(e => ({ id: e.id, runId: e.runId, actorId: e.actorId, createdAt: e.createdAt, kind: e.kind, manifest: e.manifest })) };
  }
  if (pathname.endsWith('/curation/exports')) {
    allowMethod(method, 'POST');
    const input = parseInput(LabCurationExportRequestSchema, bodyObject(options));
    validate(() => labAssertPreferenceScope(labPreferenceScope(run.info), input.scope));
    const groups = plan();
    const id = crypto.randomUUID();
    const selected = input.candidateIds.map(id => candidates().find(c => c.id === id) ?? missing('Candidate not found'));
    if (new Set(input.candidateIds).size !== input.candidateIds.length) conflict('중복 후보');
    let records: unknown[];
    let lines: unknown[];
    if (input.kind === 'train') {
      validate(() => labValidateSelection(selected, input.policy, input.scope));
      lines = selected.map(labTrainingLine);
      records = selected.map(c => ({ candidate: c, review: latest(c.caseId), originalResult: row(c.caseId) }));
    } else {
      if (input.candidateIds.length) throw new MockHttpError(400, 'VALIDATION_ERROR', '평가에는 학습 후보를 지정하지 않습니다.');
      lines = run.rows.filter(r => r.testCase.familyId && groups[labFamilyKey(r.testCase.familyId)] === input.kind && valid.has(r.caseId))
        .map(r => labEvaluationLine(run.info, r, valid.get(r.caseId)!, input.kind));
      if (!lines.length) throw new MockHttpError(400, 'VALIDATION_ERROR', '검수된 평가 사례가 없습니다.');
      records = lines;
    }
    const manifest = { mock: true, version: 'preference-v1', scope: input.scope, run: run.info, policy: input.policy, count: lines.length,
      selection: input.kind === 'train' ? labValidateSelection(selected, input.policy, input.scope) : { evaluationOnly: true },
      datasetHash: run.info.datasetHash, promptHash: run.info.promptHash, model: run.info.model, records };
    const file: LabCurationExport = { id, runId, actorId, createdAt: new Date().toISOString(), kind: input.kind,
      files: [{ filename: `mock-nickname-${input.kind === 'train' ? 'preference' : input.kind}-${id}.jsonl`, content: lines.map(r => JSON.stringify(r)).join('\n') + '\n' },
        { filename: `mock-nickname-provenance-${id}.json`, content: JSON.stringify(manifest, null, 2) }], manifest: { ...manifest, records: undefined } };
    state.families = groups; state.exports.unshift(file); return file;
  }
  const exportPath = /\/curation\/exports\/([^/]+)$/.exec(pathname);
  if (exportPath) { allowMethod(method, 'GET'); return state.exports.find(e => e.runId === runId && e.id === exportPath[1]) ?? missing('Export not found'); }
  return UNHANDLED;
}
