import { describe, expect, it } from 'vitest';
import { LabResultSchema, type LabResult } from './lab.js';
import { labDefaultReview, labFamilyPlan, labGroupSplit, labHumanMetrics, labInfrastructureFailure } from './lab-curation.js';
import { LabCurationPolicySchema, LabReviewBodySchema, LabSaveReviewSchema, type LabCandidate } from './lab-human.js';
import { labBuildPreference, labTrainingLine, labValidateSelection } from './lab-preference.js';

function result(): LabResult {
  const output = { schemaVersion: '2', nickname: '달빛산책', interpretedTerm: null, reason: '평범한 조합', score: 0, confidence: 0.8, sourceIds: ['S1'], abstained: false };
  return LabResultSchema.parse({ bertScore: null, caseId: 'one', testCase: { id: 'one', nickname: '달빛산책', familyId: 'moon', split: 'train', reference: { expectedReason: '비공개 정답', expectedScore: 0, sources: ['https://unseen.example.org'] } },
    status: 'SUCCEEDED', output, sources: [{ id: 'S1', title: '자료', url: 'https://example.org', snippet: '평범한 조합이며 후반은 모델에서 잘림', collectedAt: '2026-11-25T00:00:00Z' }],
    durationMs: 30, searchCount: 1, jsonValid: true, error: null, attempts: 1, toolSucceeded: true, toolSupport: 'unsupported',
    history: [{ event: 'finished', research: { steps: [
      { kind: 'action', systemPrompt: 'action system', prompt: '{"nickname":"달빛산책"}', suppliedSources: [], durationMs: 5,
        action: { action: 'search', query: '달빛 뜻', hypotheses: [{ term: '달빛', basis: '일상 단어' }] } },
      { kind: 'search', query: '달빛 뜻', durationMs: 10 },
      { kind: 'answer', systemPrompt: 'answer system', prompt: 'EXACT_MODEL_PROMPT', suppliedSources: [{ id: 'S1', title: '자료', snippet: '평범한 조합' }], durationMs: 15,
        rawResponse: JSON.stringify(JSON.stringify({ ...output, evidenceChecks: [] })), finishReason: 'stop', validation: { valid: true, error: null },
        answer: output, interpretationStatus: 'literal', evidenceChecks: [{ sourceId: 'S1', quote: '평범한 조합', claim: '일상어', relation: 'ordinary_usage' }] },
    ] } }] });
}
const scope = { feedbackPolicy: 'evidence-v1', promptHash: 'a'.repeat(64) };
const step = (r: LabResult) => (r.history[0] as { research: { steps: { rawResponse?: string; finishReason?: string; validation?: { valid: boolean; error: string | null }; error?: string }[] } }).research.steps[2];
const build = (r: LabResult, body = review(r), split = 'train') => labBuildPreference(r, body, split, scope);
const review = (r: LabResult) => ({ ...labDefaultReview(r), behavior: 'positive' as const, verdict: 'correct' as const, cause: 'none' as const, cohort: 'normal' as const });
describe('human curation evidence and split boundaries', () => {
  it('exports only exact inputs and original completion, with no reference or feedback metadata', () => {
    const r = result();
    const body = build(r);
    const line = labTrainingLine({ body } as LabCandidate);
    expect(line.prompt[1].content).toBe('EXACT_MODEL_PROMPT');
    expect(line.completion[0].content).toBe(JSON.parse(step(r).rawResponse!));
    expect(body.suppliedSources[0].snippet).toBe('평범한 조합');
    expect(Object.keys(line)).toEqual(['prompt', 'completion', 'label']);
    expect(JSON.stringify(line)).not.toMatch(/비공개 정답|expectedScore|unseen.example|actorId|behaviorReasons|bertScore/);
  });
  it('keeps all benchmark verdicts independent from behavior, including the four requested cases', () => {
    const r = result();
    for (const verdict of ['correct', 'partial', 'incorrect', 'deferred'] as const) {
      for (const behavior of ['positive', 'negative', 'exclude'] as const) {
        const body = LabReviewBodySchema.parse({ ...labDefaultReview(r), verdict, behavior,
          behaviorReasons: behavior === 'negative' ? ['fabricated_fact'] : [] });
        if (behavior === 'exclude') expect(() => labBuildPreference(r, body, 'train', scope)).toThrow(/학습 제외/);
        else expect(labBuildPreference(r, body, 'train', scope).label).toBe(behavior === 'positive');
      }
    }
    expect(labDefaultReview(r).behavior).toBe('exclude');
    expect(LabReviewBodySchema.safeParse({ ...review(r), behavior: 'negative', behaviorReasons: [] }).success).toBe(false);
    expect(LabSaveReviewSchema.safeParse({ previousReviewId: null, resultHash: 'a'.repeat(64),
      body: { ...review(r), correction: { reason: '교정한 모범 답안' } } }).success).toBe(false);
  });
  it('preserves invalid JSON verbatim and permits model-attributed contract feedback', () => {
    const r = result();
    const raw = 'invalid {\n NUL' + String.fromCharCode(0, 0xd800);
    step(r).rawResponse = JSON.stringify(raw);
    step(r).validation = { valid: false, error: 'INVALID_MODEL_JSON' };
    step(r).error = 'INVALID_MODEL_JSON';
    r.output = null; r.jsonValid = false; r.status = 'FAILED'; r.error = 'INVALID_MODEL_OUTPUT';
    const body = labBuildPreference(r, { ...review(r), verdict: 'incorrect', behavior: 'negative', behaviorReasons: ['model_contract_violation'] }, 'train', scope);
    const line = labTrainingLine({ body } as LabCandidate);
    expect(line.label).toBe(false); expect(line.completion[0].content).toBe(raw);
    expect(JSON.parse(JSON.stringify(line))).toEqual(line);
    expect(() => labBuildPreference(result(), { ...review(r), behavior: 'negative', behaviorReasons: ['model_contract_violation'] }, 'train', scope)).toThrow(/검증된/);
  });
  it('rejects held-out families, legacy records, missing raw output, truncation, and infrastructure failures', () => {
    for (const split of ['test', 'validation']) expect(() => build(result(), review(result()), split)).toThrow(/평가 전용/);
    const legacy = { ...review(result()), feedbackVersion: undefined, behavior: undefined };
    expect(() => labBuildPreference(result(), legacy, 'train', scope)).toThrow(/과거/);
    expect(() => labBuildPreference(result(), review(result()), 'train', null)).toThrow(/정책/);
    for (const reason of ['length', 'unknown']) { const r = result(); step(r).finishReason = reason; expect(() => build(r)).toThrow(/잘림/); }
    for (const error of ['PROVIDER_UNREACHABLE', 'ATTEMPT_LIMIT', 'CASE_TIMEOUT', 'MODEL_BUSY', 'MODEL_OUTPUT_TRUNCATED']) {
      const r = { ...result(), status: 'FAILED' as const, output: null, error };
      expect(labInfrastructureFailure(r)).toBe(true); expect(() => build(r)).toThrow(/장애/);
    }
    const r = result(); delete step(r).rawResponse;
    expect(() => build(r)).toThrow(/재실행/);
    const retried = result(); retried.history.push({ event: 'finished', error: 'INVALID_MODEL_JSON' });
    expect(() => build(retried)).toThrow(/재실행/);
    const failedSearch = result();
    (failedSearch.history[0] as { research: { steps: { error?: string }[] } }).research.steps[1].error = 'PROVIDER_HTTP_503';
    expect(() => build(failedSearch)).toThrow(/장애/);
  });
  it('does not treat general knowledge, a low similarity score, or score mismatch as negative feedback', () => {
    const r = result(); r.searchCount = 0; r.sources = []; r.output!.score = 99;
    expect(build(r).label).toBe(true);
    expect(() => labBuildPreference(r, labDefaultReview(r), 'train', scope)).toThrow(/학습 제외/);
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
  it('requires positive balance, selected policy/prompt scope, approval, freshness, and family limits', () => {
    const body = build(result());
    const c = { id: 'a', runId: 'run', caseId: 'one', status: 'approved', stale: false, body } as LabCandidate;
    const d = { ...c, id: 'b', caseId: 'two', body: { ...body, familyId: 'second', label: false, reasons: ['excessive_risk' as const] } };
    const policy = LabCurationPolicySchema.parse({});
    expect(labValidateSelection([c, d], policy, scope)).toMatchObject({ count: 2, positive: 1, negative: 1 });
    expect(() => labValidateSelection([c, { ...d, body: { ...d.body, familyId: body.familyId } }], policy, scope)).toThrow(/비중/);
    expect(() => labValidateSelection([c, { ...d, stale: true }], policy, scope)).toThrow(/변경/);
    expect(() => labValidateSelection([{ ...c, body: { ...body, label: false } }, d], policy, scope)).toThrow(/긍정/);
    expect(() => labValidateSelection([c, { ...d, caseId: c.caseId }], policy, scope)).toThrow(/중복/);
    for (const patch of [{ feedbackPolicy: 'incompatible' }, { promptHash: 'b'.repeat(64) }])
      expect(() => labValidateSelection([c, d], policy, { ...scope, ...patch })).toThrow(/정책·프롬프트/);
    expect(() => labValidateSelection([{ ...c, status: 'draft' }, d], policy, scope)).toThrow(/미승인/);
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
