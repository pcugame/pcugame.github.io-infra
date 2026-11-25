import { z } from 'zod';
import { LabOutputSchema, type LabCase, type LabResult, type LabRun } from './lab.js';
import { LabResearchActionSchema, LabResearchAnswerSchema } from './lab-research.js';
import { type LabReviewBody, type LabHumanMetrics } from './lab-human.js';

export const labFamilyKey = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
type Split = 'train' | 'validation' | 'test';
// A fixed family hash, never a row shuffle or a tuneable seed. Explicit imported assignments take precedence.
export function labGroupSplit(family: string): Split {
  let hash = 2166136261;
  for (const char of labFamilyKey(family)) { hash ^= char.codePointAt(0)!; hash = Math.imul(hash, 16777619); }
  const bucket = (hash >>> 0) % 10;
  return bucket < 8 ? 'train' : bucket === 8 ? 'validation' : 'test';
}
export function labFamilyPlan(cases: Pick<LabCase, 'nickname' | 'familyId' | 'split'>[], fixed: Record<string, Split> = {}): Record<string, Split> {
  const plan = { ...fixed };
  const names = new Map<string, string>();
  const explicit = new Map<string, Split>();
  const families = new Set<string>();
  for (const item of cases) {
    if (!item.familyId) continue;
    const family = labFamilyKey(item.familyId);
    const name = labFamilyKey(item.nickname);
    if (names.has(name) && names.get(name) !== family) throw new Error('동일 닉네임의 표현군이 데이터셋 간에 다릅니다.');
    names.set(name, family);
    families.add(family);
    if (item.split) {
      if ((explicit.has(family) && explicit.get(family) !== item.split) || (plan[family] && plan[family] !== item.split))
        throw new Error(`표현군 ${family}의 split 충돌: 고정 분할을 변경할 수 없습니다.`);
      explicit.set(family, item.split);
    }
  }
  for (const family of families) plan[family] ??= explicit.get(family) ?? labGroupSplit(family);
  const nicknameSplits = new Map<string, Split>();
  for (const item of cases) {
    const split = item.familyId ? plan[labFamilyKey(item.familyId)] : item.split;
    if (!split) continue;
    const name = labFamilyKey(item.nickname);
    if (nicknameSplits.has(name) && nicknameSplits.get(name) !== split)
      throw new Error('동일 닉네임의 split 충돌: familyId가 없던 test 사례도 학습으로 이동할 수 없습니다.');
    nicknameSplits.set(name, split);
  }
  return plan;
}
const shownSchema = z.object({ id: z.string(), title: z.string(), snippet: z.string() });
const stepSchema = z.object({
  kind: z.string(), durationMs: z.number().optional(), query: z.string().optional(), error: z.string().optional(),
  systemPrompt: z.string().optional(), prompt: z.string().optional(), suppliedSources: z.array(shownSchema).optional(),
  action: LabResearchActionSchema.optional(), answer: LabOutputSchema.optional(),
  interpretationStatus: LabResearchAnswerSchema.shape.interpretationStatus.optional(),
  evidenceChecks: LabResearchAnswerSchema.shape.evidenceChecks.optional(),
}).passthrough();
const attemptSchema = z.object({
  event: z.string().optional(), error: z.string().nullable().optional(),
  research: z.object({ steps: z.array(stepSchema) }).passthrough().optional(),
  generationContexts: z.array(z.object({ messages: z.array(z.object({ role: z.string(), content: z.string().nullable().optional() }).passthrough()),
    suppliedSources: z.array(shownSchema), stage: z.string(), durationMs: z.number().optional() }).passthrough()).optional(),
  searchSteps: z.array(z.object({ query: z.string(), durationMs: z.number(), error: z.string().optional() })).optional(),
  searchDurationMs: z.number().optional(), generationDurationMs: z.number().optional(),
}).passthrough();
export function labLastAttempt(result: LabResult) {
  // Do not fall back to an older successful attempt after a failed retry.
  const entries = result.history.filter(v => v && typeof v === 'object' && 'event' in v && v.event === 'finished');
  const parsed = attemptSchema.safeParse(entries.at(-1) ?? result.history.at(-1));
  return parsed.success ? parsed.data : null;
}
const modelErrors = new Set(['INVALID_MODEL_OUTPUT', 'INVALID_MODEL_JSON', 'INVALID_RESEARCH_ACTION',
  'TOOL_INVALID_ARGUMENTS', 'TOOL_INVALID_ID', 'UNKNOWN_SOURCE_ID', 'UNKNOWN_TOOL', 'TOOL_CALL_LIMIT', 'SEARCH_LIMIT']);
export function labInfrastructureFailure(result: LabResult): boolean {
  const attempt = labLastAttempt(result);
  return !!(result.status === 'FAILED' && (!result.error || !modelErrors.has(result.error))) ||
    !!attempt?.research?.steps.some(s => s.kind === 'search' && s.error) || !!attempt?.searchSteps?.some(s => s.error);
}
export function labDefaultReview(result: LabResult): LabReviewBody {
  return { feedbackVersion: 'preference-v1', behavior: 'exclude', behaviorReasons: [], verdict: 'deferred', errors: [], cause: labInfrastructureFailure(result) ? 'infrastructure' : 'unknown',
    cohort: null, rationaleFit: null, interpretationSuccess: null, sourceChecks: [], notes: '', blind: true,
    correction: {}, correctedAction: null, reusedReference: false };
}
export function labHumanMetrics(results: LabResult[], reviews: Map<string, LabReviewBody>, riskThreshold = 50, staleReviews = 0): LabHumanMetrics {
  const total = results.length;
  const metrics: LabHumanMetrics['metrics'] = [];
  const add = (key: string, label: string, values: (number | null)[], unit: 'rate' | 'score' | 'ms', fullDenominator = true) => {
    const measured = values.filter((v): v is number => v !== null);
    const numerator = measured.reduce((sum, v) => sum + v, 0);
    const denominator = fullDenominator ? values.length : measured.length;
    metrics.push({ key, label, numerator, denominator, missing: values.length - measured.length,
      value: denominator ? numerator / denominator : null, unit });
  };
  const score = (r: LabResult) => r.status === 'SUCCEEDED' && r.jsonValid ? r.output?.score ?? null : null;
  add('rationale', '판단 근거 적합률', results.map(r => reviews.get(r.caseId)?.rationaleFit == null ? null : Number(reviews.get(r.caseId)!.rationaleFit)), 'rate');
  add('mae', '점수 MAE (채점 가능 사례)', results.map(r => score(r) === null ? null : Math.abs(score(r)! - r.testCase.reference.expectedScore)), 'score', false);
  add('range', '기대 점수 범위 충족률 (전체)', results.map(r => { const value = score(r); const range = r.testCase.reference.scoreRange ?? [r.testCase.reference.expectedScore, r.testCase.reference.expectedScore];
    return value === null ? null : Number(value >= range[0] && value <= range[1]); }), 'rate');
  for (const [cohort, key, label, positive] of [['normal', 'falsePositive', '정상 닉네임 오탐률', true], ['problematic', 'falseNegative', '문제 닉네임 미탐률', false]] as const) {
    const selected = results.filter(r => reviews.get(r.caseId)?.cohort === cohort);
    add(key, label, selected.map(r => score(r) === null ? null : Number(positive ? score(r)! >= riskThreshold : score(r)! < riskThreshold)), 'rate');
    add(key + 'Unresolved', label + ' 대상 미채점률', selected.map(r => Number(score(r) === null)), 'rate');
  }
  add('interpretation', '해석·난독화 복원 성공률', results.map(r => reviews.get(r.caseId)?.interpretationSuccess == null ? null : Number(reviews.get(r.caseId)!.interpretationSuccess)), 'rate');
  for (const [field, label] of [['relevant', '인용 출처 관련성'], ['supports', '인용 출처 근거 지지율']] as const)
    add(field, label, results.flatMap(r => (r.output?.sourceIds ?? []).map(id => { const value = reviews.get(r.caseId)?.sourceChecks.find(c => c.sourceId === id)?.[field]; return value == null ? null : Number(value); })), 'rate');
  add('abstention', '판단 유보율 (전체)', results.map(r => r.output ? Number(r.output.abstained || r.output.score === null) : null), 'rate');
  add('unresolved', '판단 유보·실패·미완료 비율', results.map(r => Number(score(r) === null)), 'rate');
  add('json', 'JSON 유효 응답률 (전체)', results.map(r => Number(r.status === 'SUCCEEDED' && r.jsonValid)), 'rate');
  add('meanScore', '평균 위험 점수', results.map(score), 'score', false);
  add('highRisk', '높은 위험 점수 부여율 (전체)', results.map(r => score(r) === null ? null : Number(score(r)! >= riskThreshold)), 'rate');
  for (const kind of ['search', 'generation'] as const) add(kind + 'Ms', kind === 'search' ? '검색 시간' : '생성 시간', results.map(r => {
    const attempt = labLastAttempt(r);
    if (attempt?.research) return attempt.research.steps.filter(s => kind === 'search' ? s.kind === 'search' : s.kind !== 'search').reduce((sum, s) => sum + (s.durationMs ?? 0), 0);
    return (kind === 'search' ? attempt?.searchDurationMs : attempt?.generationDurationMs) ?? null;
  }), 'ms', false);
  for (const key of ['precision', 'recall', 'f1'] as const) add('bertScore_' + key, 'BERTScore ' + key + ' (근거 유사도)', results.map(r => r.bertScore?.status === 'SUCCEEDED' ? r.bertScore[key] : null), 'score', false);
  return { total, reviewed: reviews.size, staleReviews, failed: results.filter(r => r.status === 'FAILED').length,
    cancelled: results.filter(r => r.status === 'CANCELLED').length, pending: results.filter(r => ['PENDING', 'RUNNING'].includes(r.status)).length,
    infrastructure: results.filter(labInfrastructureFailure).length,
    unknownCohort: total - [...reviews.values()].filter(r => r.cohort !== null).length, riskThreshold, metrics };
}
export function labEvaluationLine(run: Pick<LabRun, 'id' | 'datasetHash'>, result: LabResult, review: LabReviewBody, split: Split) {
  return { purpose: 'evaluation_only', split, runId: run.id, datasetHash: run.datasetHash, case: result.testCase, result, review };
}
