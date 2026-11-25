import { z } from 'zod';
import { LabOutputSchema, type LabCase, type LabResult, type LabRun } from './lab.js';
import { LAB_RESEARCH_ACTION_PROMPT, LAB_RESEARCH_SYSTEM_PROMPT, LabResearchActionSchema, LabResearchAnswerSchema } from './lab-research.js';
import { LabCandidateBodySchema, type LabCandidate, type LabCandidateBody, type LabCreateCandidate,
  type LabReviewBody, type LabHumanMetrics, type LabCurationExportRequest } from './lab-human.js';

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
const modelErrors = new Set(['INVALID_MODEL_OUTPUT', 'INVALID_MODEL_JSON', 'INVALID_RESEARCH_ACTION', 'MODEL_OUTPUT_TRUNCATED',
  'TOOL_INVALID_ARGUMENTS', 'TOOL_INVALID_ID', 'UNKNOWN_SOURCE_ID', 'UNKNOWN_TOOL', 'TOOL_CALL_LIMIT', 'SEARCH_LIMIT']);
export function labInfrastructureFailure(result: LabResult): boolean {
  const attempt = labLastAttempt(result);
  return !!(result.status === 'FAILED' && (!result.error || !modelErrors.has(result.error))) ||
    !!attempt?.research?.steps.some(s => s.kind === 'search' && s.error) || !!attempt?.searchSteps?.some(s => s.error);
}
export function labDefaultReview(result: LabResult): LabReviewBody {
  return { verdict: 'deferred', errors: [], cause: labInfrastructureFailure(result) ? 'infrastructure' : 'unknown',
    cohort: null, rationaleFit: null, interpretationSuccess: null, sourceChecks: [], notes: '', blind: true,
    correction: {}, correctedAction: null, reusedReference: false };
}
export function labBuildCandidate(result: LabResult, review: LabReviewBody, request: LabCreateCandidate, split: Split): LabCandidateBody {
  if (split !== 'train') throw new Error('학습 후보는 train 표현군에서만 생성할 수 있습니다. validation/test는 평가 전용입니다.');
  if (!review.cohort) throw new Error('학습 선별 전에 정상·문제·모호 사례 유형을 지정하세요.');
  if (!result.testCase.familyId) throw new Error('학습 선별 전에 데이터셋에 familyId를 지정하세요.');
  if (!['SUCCEEDED', 'FAILED'].includes(result.status)) throw new Error('실행이 완료된 결과만 검수할 수 있습니다.');
  if (review.verdict === 'deferred' || ['infrastructure', 'reference', 'unknown'].includes(review.cause) ||
      review.errors.some(e => ['retrieval_failure', 'reference'].includes(e)) || labInfrastructureFailure(result))
    throw new Error('실행 장애·기대 정답 문제·원인 미분류·평가 보류는 학습 후보에서 제외합니다.');
  if (review.verdict !== 'correct' && review.cause === 'none') throw new Error('오류 사례의 문제 영역을 먼저 분류하세요.');
  const attempt = labLastAttempt(result);
  const steps = attempt?.research?.steps ?? [];
  let target: unknown;
  let suppliedSources: z.infer<typeof shownSchema>[] = [];
  let messages: LabCandidateBody['messages'];
  let contextOrigin: string;
  let stepIndex: number | null = null;
  if (request.objective === 'A') {
    const indices = steps.flatMap((s, i) => s.kind === 'action' ? [i] : []);
    stepIndex = request.stepIndex ?? indices[0] ?? null;
    const step = stepIndex === null ? undefined : steps[stepIndex];
    if (request.stepIndex !== undefined && !step) throw new Error('존재하는 생성 단계를 선택하세요.');
    if (step && step.kind !== 'action') throw new Error('검색 action 단계를 선택하세요.');
    target = LabResearchActionSchema.parse(review.correctedAction ?? step?.action);
    const action = target as z.infer<typeof LabResearchActionSchema>;
    if (action.action === 'search' ? !action.query?.trim() : action.query !== null) throw new Error('유효한 교정 action이 필요합니다.');
    suppliedSources = step?.suppliedSources ?? [];
    // A new first action has nickname-only input. Never supply reference facts or synthetic search results.
    messages = [{ role: 'system', content: step?.systemPrompt ?? LAB_RESEARCH_SYSTEM_PROMPT + '\n' + LAB_RESEARCH_ACTION_PROMPT },
      { role: 'user', content: step?.prompt ?? JSON.stringify({ case: { nickname: result.testCase.nickname }, sources: [], searchesRemaining: 2 }) }];
    contextOrigin = step?.prompt ? 'recorded_action' : 'nickname_only_action';
  } else {
    const emptyAnswer = { schemaVersion: '2', nickname: result.testCase.nickname, interpretedTerm: null, score: null, confidence: 0, sourceIds: [], abstained: true };
    const base = result.output ?? emptyAnswer;
    const answerIndices = steps.flatMap((s, i) => s.kind === 'answer' ? [i] : []);
    stepIndex = request.stepIndex ?? answerIndices.at(-1) ?? null;
    const step = stepIndex === null ? undefined : steps[stepIndex];
    if (request.stepIndex !== undefined && !step) throw new Error('존재하는 생성 단계를 선택하세요.');
    if (step && step.kind !== 'answer') throw new Error('최종 판단 단계를 선택하세요.');
    if (step?.systemPrompt && step.prompt && step.suppliedSources) {
      suppliedSources = step.suppliedSources;
      target = LabResearchAnswerSchema.parse({ ...(step.answer ?? emptyAnswer),
        evidenceChecks: step.evidenceChecks ?? [], interpretationStatus: step.interpretationStatus ?? 'literal', ...review.correction });
      messages = [{ role: 'system', content: step.systemPrompt }, { role: 'user', content: step.prompt }];
      contextOrigin = 'recorded_research_answer';
    } else {
      const context = attempt?.generationContexts?.filter(c => c.stage === 'answer').at(-1);
      if (!context || context.messages.some(m => !['system', 'user'].includes(m.role) || typeof m.content !== 'string'))
        throw new Error('정확한 모델 입력 기록이 없습니다. 다시 실행하거나 A 교정 action을 사용하세요.');
      suppliedSources = context.suppliedSources;
      const { evidenceChecks: _checks, interpretationStatus: _status, ...correction } = review.correction;
      target = LabOutputSchema.parse({ ...base, ...correction });
      messages = context.messages.map(m => ({ role: m.role as 'system' | 'user', content: m.content! }));
      contextOrigin = 'recorded_answer';
    }
    const output = LabOutputSchema.strip().parse(target);
    if (output.nickname !== result.testCase.nickname || (output.abstained && output.score !== null))
      throw new Error('닉네임·판단 유보·점수 계약을 확인하세요.');
    if (new Set(output.sourceIds).size !== output.sourceIds.length || output.sourceIds.some(id => !suppliedSources.some(s => s.id === id)))
      throw new Error('모델에 실제 제공한 출처 ID만 사용할 수 있습니다.');
    // URLs are provenance metadata, not model-generated answers. Human references cannot inject unseen URLs.
    if (/https?:\/\//i.test(output.reason + (output.interpretedTerm ?? ''))) throw new Error('응답에는 URL 대신 제공된 출처 ID를 사용하세요.');
    if (contextOrigin === 'recorded_research_answer') {
      const answer = LabResearchAnswerSchema.parse(target);
      if (answer.evidenceChecks.some(e => !suppliedSources.some(s => s.id === e.sourceId && !!e.quote.trim() && s.snippet.includes(e.quote))) ||
        answer.sourceIds.some(id => !answer.evidenceChecks.some(e => e.sourceId === id && e.relation !== 'unrelated')) ||
        (answer.interpretationStatus === 'unverified_hypothesis' && (!answer.abstained || answer.score !== null)) ||
        (answer.interpretationStatus === 'supported_hypothesis' && !answer.sourceIds.length))
        throw new Error('교정 인용문·해석 상태가 실제 제공 자료와 일치하지 않습니다.');
    }
    if (request.objective === 'B' && !suppliedSources.length)
      throw new Error('B는 실제 제공된 자료가 필요합니다. 검색 행동은 A, 자료 없는 JSON 교정은 C를 사용하세요.');
  }
  return LabCandidateBodySchema.parse({ version: 'human-curation-v1', objective: request.objective,
    familyId: labFamilyKey(result.testCase.familyId), split, cohort: review.cohort, errors: review.errors,
    retention: review.verdict === 'correct' && !Object.keys(review.correction).length && !review.correctedAction, messages: [...messages, { role: 'assistant', content: JSON.stringify(target) }],
    suppliedSources, contextOrigin, stepIndex, reusedReference: review.reusedReference,
    warnings: ['출처 내용의 의미적 지지 여부와 모델이 보지 못한 사실의 포함 여부를 사람이 확인해야 합니다.',
      ...(review.reusedReference ? ['기대 근거를 재사용한 초안입니다. 기존 정답이 현재 제공 자료로 뒷받침되는지 확인하세요.'] : [])] });
}
export function labValidateSelection(candidates: LabCandidate[], policy: LabCurationExportRequest['policy']) {
  if (!candidates.length) throw new Error('승인된 학습 후보를 선택하세요.');
  if (candidates.some(c => c.status !== 'approved' || c.stale || c.body.split !== 'train')) throw new Error('미승인·변경된 검수·평가 전용 후보는 내보낼 수 없습니다.');
  const families = new Map<string, number>();
  const errors = new Map<string, number>();
  const cases = new Set<string>();
  for (const c of candidates) {
    // One representative per original case in a release, even if several objectives were drafted.
    const key = c.runId + '/' + c.caseId;
    if (cases.has(key)) throw new Error('같은 사례의 여러 후보를 한 학습 파일에 중복 포함할 수 없습니다.');
    cases.add(key);
    const family = c.body.familyId;
    families.set(family, (families.get(family) ?? 0) + 1);
    for (const error of c.body.errors.length ? c.body.errors : ['correct']) {
      const group = family + '/' + error;
      errors.set(group, (errors.get(group) ?? 0) + 1);
    }
  }
  if ([...families.values()].some(n => n > policy.maxPerFamily || n / candidates.length > policy.maxFamilyShare))
    throw new Error('표현군별 건수 또는 최대 비중을 초과했습니다. 다른 표현군의 대표 사례를 함께 선택하세요.');
  if ([...errors.values()].some(n => n > policy.maxPerFamilyError)) throw new Error('동일 표현군·오류 유형의 대표 사례 한도를 초과했습니다.');
  const retention = candidates.filter(c => c.body.retention).length;
  if (retention / candidates.length < policy.minRetentionShare) throw new Error('기존 능력 보존을 위한 정답 사례의 최소 비율을 충족하지 못했습니다.');
  const normal = candidates.filter(c => c.body.retention && c.body.cohort === 'normal').length;
  const ambiguous = candidates.filter(c => c.body.retention && c.body.cohort === 'ambiguous').length;
  if (normal / candidates.length < policy.minNormalShare || ambiguous / candidates.length < policy.minAmbiguousShare)
    throw new Error('정상·모호 닉네임 정답 보존 사례의 최소 비율을 충족하지 못했습니다.');
  return { count: candidates.length, retention, normal, ambiguous, families: Object.fromEntries(families), familyErrors: Object.fromEntries(errors),
    cohorts: Object.fromEntries(['normal', 'problematic', 'ambiguous'].map(k => [k, candidates.filter(c => c.body.cohort === k).length])) };
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
export function labTrainingLine(candidate: LabCandidate) { return { messages: candidate.body.messages }; }
export function labEvaluationLine(run: Pick<LabRun, 'id' | 'datasetHash'>, result: LabResult, review: LabReviewBody, split: Split) {
  return { purpose: 'evaluation_only', split, runId: run.id, datasetHash: run.datasetHash, case: result.testCase, result, review };
}
