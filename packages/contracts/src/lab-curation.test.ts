import { describe, expect, it } from 'vitest';
import { LabResultSchema, type LabResult } from './lab.js';
import { labBuildCandidate, labDefaultReview, labFamilyPlan, labGroupSplit, labHumanMetrics, labInfrastructureFailure, labValidateSelection } from './lab-curation.js';
import { LabCurationPolicySchema, type LabCandidate } from './lab-human.js';

function result(): LabResult {
  const output = { schemaVersion: '2', nickname: '달빛산책', interpretedTerm: null, reason: '평범한 조합', score: 0, confidence: 0.8, sourceIds: ['S1'], abstained: false };
  return LabResultSchema.parse({ caseId: 'one', testCase: { id: 'one', nickname: '달빛산책', familyId: 'moon', split: 'train', reference: { expectedReason: '비공개 정답', expectedScore: 0, sources: ['https://unseen.example.org'] } },
    status: 'SUCCEEDED', output, sources: [{ id: 'S1', title: '자료', url: 'https://example.org', snippet: '평범한 조합이며 후반은 모델에서 잘림', collectedAt: '2026-11-25T00:00:00Z' }],
    durationMs: 30, searchCount: 1, jsonValid: true, error: null, attempts: 1, toolSucceeded: true, toolSupport: 'unsupported',
    history: [{ event: 'finished', research: { steps: [
      { kind: 'action', systemPrompt: 'action system', prompt: '{"nickname":"달빛산책"}', suppliedSources: [], durationMs: 5,
        action: { action: 'search', query: '달빛 뜻', hypotheses: [{ term: '달빛', basis: '일상 단어' }] } },
      { kind: 'search', query: '달빛 뜻', durationMs: 10 },
      { kind: 'answer', systemPrompt: 'answer system', prompt: 'EXACT_MODEL_PROMPT', suppliedSources: [{ id: 'S1', title: '자료', snippet: '평범한 조합' }], durationMs: 15,
        answer: output, interpretationStatus: 'literal', evidenceChecks: [{ sourceId: 'S1', quote: '평범한 조합', claim: '일상어', relation: 'ordinary_usage' }] },
    ] } }] });
}
const request = { reviewId: '00000000-0000-4000-8000-000000000001', objective: 'B' as const };
const review = (r: LabResult) => ({ ...labDefaultReview(r), verdict: 'correct' as const, cause: 'none' as const, cohort: 'normal' as const });
describe('human curation evidence and split boundaries', () => {
  it('uses exact supplied snippets and original prompts, not reference facts or collected-but-truncated text', () => {
    const r = result();
    const c = labBuildCandidate(r, review(r), request, 'train');
    expect(c.messages[1].content).toBe('EXACT_MODEL_PROMPT');
    expect(() => labBuildCandidate(r, review(r), { ...request, stepIndex: 999 }, 'train')).toThrow(/존재하는/);
    expect(c.suppliedSources[0].snippet).toBe('평범한 조합');
    expect(JSON.stringify(c)).not.toContain('비공개 정답');
    expect(JSON.stringify(c)).not.toContain('unseen.example.org');
    expect(() => labBuildCandidate(r, { ...review(r), correction: { sourceIds: ['S2'] } }, request, 'train')).toThrow(/출처/);
    expect(() => labBuildCandidate(r, { ...review(r), correction: { evidenceChecks: [{ sourceId: 'S1', quote: '후반은 모델에서 잘림', claim: '불가', relation: 'ordinary_usage' }] } }, request, 'train')).toThrow(/인용문/);
    expect(() => labBuildCandidate(r, { ...review(r), correction: { reason: 'https://unseen.example.org' } }, request, 'train')).toThrow(/URL/);
  });
  it('excludes test, validation, unresolved causes, wrong gold and service failures', () => {
    const r = result();
    for (const split of ['test', 'validation'] as const) expect(() => labBuildCandidate(r, review(r), request, split)).toThrow(/평가 전용/);
    for (const cause of ['reference', 'unknown', 'infrastructure'] as const) expect(() => labBuildCandidate(r, { ...review(r), cause }, request, 'train')).toThrow(/제외/);
    for (const error of ['PROVIDER_UNREACHABLE', 'ATTEMPT_LIMIT', 'CASE_TIMEOUT', 'MODEL_BUSY']) {
      const failed = { ...r, status: 'FAILED' as const, output: null, error };
      expect(labInfrastructureFailure(failed)).toBe(true);
      expect(() => labBuildCandidate(failed, review(failed), { ...request, objective: 'A' }, 'train')).toThrow(/장애/);
    }
    const failedSearch = result();
    (failedSearch.history[0] as { research: { steps: { error?: string }[] } }).research.steps[1]!.error = 'PROVIDER_HTTP_503';
    expect(labInfrastructureFailure(failedSearch)).toBe(true);
  });
  it('teaches a corrected action with no fabricated results and does not reuse a prior attempt', () => {
    const r = { ...result(), history: [{ event: 'finished', error: 'INVALID_MODEL_JSON' }], output: null, status: 'FAILED' as const, error: 'INVALID_MODEL_JSON' };
    const action = { action: 'search' as const, query: '달빛 뜻', hypotheses: [] };
    const c = labBuildCandidate(r, { ...review(r), correctedAction: action }, { ...request, objective: 'A' }, 'train');
    expect(c.suppliedSources).toEqual([]);
    expect(JSON.parse(c.messages.at(-1)!.content)).toEqual(action);
    expect(() => labBuildCandidate(r, review(r), request, 'train')).toThrow(/입력 기록/);
    const retried = result(); retried.history.push({ event: 'finished', error: 'INVALID_MODEL_JSON' });
    expect(() => labBuildCandidate(retried, review(retried), request, 'train')).toThrow(/입력 기록/);
  });
  it('freezes normalized families across datasets and never splits rows randomly', () => {
    const one = result().testCase;
    expect(labGroupSplit(' MOON ')).toBe(labGroupSplit('moon'));
    expect(labFamilyPlan([one, { ...one, nickname: '다른표기', familyId: 'ＭＯＯＮ' }])).toEqual({ moon: 'train' });
    expect(() => labFamilyPlan([one, { ...one, nickname: '변형', split: 'test' }])).toThrow(/충돌/);
    expect(() => labFamilyPlan([{ ...one, split: 'train' }], { moon: 'test' })).toThrow(/충돌/);
    expect(() => labFamilyPlan([one, { ...one, familyId: 'new-name', split: 'test' }])).toThrow(/표현군/);
    expect(() => labFamilyPlan([{ ...one, familyId: undefined, split: 'test' }, one])).toThrow(/split 충돌/);
    expect(labFamilyPlan([{ ...one, familyId: undefined, split: undefined }, one])).toEqual({ moon: 'train' });
  });
  it('enforces representative family/error limits, freshness, approval and correct-case retention', () => {
    const body = labBuildCandidate(result(), review(result()), request, 'train');
    const c = { id: 'a', runId: 'run', caseId: 'one', status: 'approved', stale: false, body } as LabCandidate;
    const d = { ...c, id: 'b', caseId: 'two', body: { ...body, familyId: 'second', retention: false, errors: ['score' as const] } };
    const policy = LabCurationPolicySchema.parse({ minAmbiguousShare: 0 });
    expect(() => labValidateSelection([c, d], LabCurationPolicySchema.parse({}))).toThrow(/정상·모호/);
    expect(labValidateSelection([c, d], policy)).toMatchObject({ count: 2, retention: 1 });
    expect(() => labValidateSelection([c, { ...d, body: { ...d.body, familyId: body.familyId } }], policy)).toThrow(/비중/);
    expect(() => labValidateSelection([c, { ...d, stale: true }], policy)).toThrow(/변경/);
    expect(() => labValidateSelection([{ ...c, body: { ...body, retention: false } }, d], policy)).toThrow(/최소 비율/);
    expect(() => labValidateSelection([c, { ...d, caseId: c.caseId }], policy)).toThrow(/중복/);
  });
});
describe('evaluation denominators', () => {
  it('keeps abstentions, failures and unreviewed cases visible, with score coverage and unknown cohorts', () => {
    const a = result();
    const b = { ...result(), caseId: 'two', output: { ...result().output!, score: null, abstained: true } };
    const c = { ...result(), caseId: 'three', output: null, status: 'FAILED' as const, jsonValid: false, error: 'PROVIDER_UNREACHABLE', history: [] };
    const report = labHumanMetrics([a, b, c], new Map([[a.caseId, { ...review(a), rationaleFit: true, interpretationSuccess: true }], [b.caseId, { ...review(b), cohort: 'problematic' }]]));
    expect(report).toMatchObject({ total: 3, reviewed: 2, failed: 1, infrastructure: 1, unknownCohort: 1 });
    const metric = (key: string) => report.metrics.find(m => m.key === key);
    expect(metric('rationale')).toMatchObject({ numerator: 1, denominator: 3, missing: 2 });
    expect(metric('mae')).toMatchObject({ denominator: 1, missing: 2 });
    expect(metric('range')).toMatchObject({ denominator: 3, value: 1 / 3 });
    expect(metric('json')).toMatchObject({ denominator: 3, value: 2 / 3 });
    expect(metric('unresolved')).toMatchObject({ numerator: 2, denominator: 3 });
    expect(metric('falseNegativeUnresolved')).toMatchObject({ numerator: 1, denominator: 1 });
    expect(metric('relevant')).toMatchObject({ denominator: 2, missing: 2 });
    expect(metric('searchMs')).toMatchObject({ denominator: 2, missing: 1, value: 10 });
  });
});
