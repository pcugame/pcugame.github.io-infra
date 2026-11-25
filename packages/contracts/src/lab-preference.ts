import { z } from 'zod';
import type { LabResult } from './lab.js';
import { labFamilyKey, labInfrastructureFailure, labLastAttempt } from './lab-curation.js';
import { LabPreferenceBodySchema, type LabCandidate, type LabPreferenceBody, type LabPreferenceScope,
  type LabReviewBody, type LabCurationExportRequest } from './lab-human.js';

const source = z.object({ id: z.string(), title: z.string(), snippet: z.string() });
const generation = z.object({
  kind: z.string().optional(), stage: z.string().optional(), rawResponse: z.string().optional(),
  rawResponseEncoding: z.literal('json-string').optional(),
  finishReason: z.string().optional(), error: z.string().optional(),
  validation: z.object({ valid: z.boolean(), error: z.string().nullable() }).optional(),
  systemPrompt: z.string().optional(), prompt: z.string().optional(),
  messages: LabPreferenceBodySchema.shape.prompt.optional(), suppliedSources: z.array(source),
});
const modelFaults = new Set(['INVALID_MODEL_JSON', 'INVALID_MODEL_OUTPUT', 'UNKNOWN_SOURCE_ID']);

// Only the last final-answer call in the latest finished attempt. Never substitute a parsed result,
// a previous successful retry, an action, or a human correction for the actual completion.
export function labFinalGeneration(result: LabResult) {
  const attempt = labLastAttempt(result);
  const research = !!attempt?.research;
  const steps = research ? attempt!.research!.steps : attempt?.generationContexts ?? [];
  const index = steps.map((s, i) => ('kind' in s ? s.kind : s.stage) === 'answer' ? i : -1).filter(i => i >= 0).at(-1) ?? -1;
  const parsed = generation.safeParse(steps[index]);
  if (!parsed.success || !parsed.data.rawResponse)
    throw new Error('최종 응답 원문·입력 기록이 없습니다. 이 실험을 재실행하세요.');
  const step = parsed.data;
  let raw: unknown;
  try { raw = JSON.parse(step.rawResponse!); } catch { throw new Error('원문 기록 형식을 확인할 수 없습니다. 재실행하세요.'); }
  // Earlier chat workers stored the assistant envelope; its content is recorded text, not reconstructed JSON.
  if (!research && step.rawResponseEncoding !== 'json-string' && typeof raw === 'object' && raw !== null && 'content' in raw)
    raw = raw.content;
  if (typeof raw !== 'string' || !raw.length) throw new Error('최종 응답 원문이 비어 있습니다. 재실행하세요.');
  if (step.finishReason !== 'stop') throw new Error('응답 잘림 또는 종료 상태 미확인: 재실행 후 검수하세요.');
  if (step.error && !modelFaults.has(step.error)) throw new Error('모델 행동으로 귀속할 수 없는 실행 오류입니다.');
  const prompt = research && typeof step.systemPrompt === 'string' && typeof step.prompt === 'string'
    ? [{ role: 'system' as const, content: step.systemPrompt }, { role: 'user' as const, content: step.prompt }]
    : step.messages;
  if (!prompt?.length || !prompt.some(m => m.role === 'user')) throw new Error('정확한 모델 입력이 없습니다. 재실행하세요.');
  return { step, prompt, raw, stepIndex: index, contextOrigin: research ? 'research' as const : 'chat' as const };
}

export function labBuildPreference(result: LabResult, review: LabReviewBody, split: string | null, scope: LabPreferenceScope | null): LabPreferenceBody {
  if (review.feedbackVersion !== 'preference-v1' || !review.behavior)
    throw new Error('과거 검수 이력입니다. 행동 피드백을 별도로 저장하세요.');
  if (review.behavior === 'exclude') throw new Error('학습 제외로 지정한 피드백입니다.');
  if (!scope) throw new Error('이 실험에 행동 평가 정책이 없습니다. 정책을 선택하여 재실행하세요.');
  if (split !== 'train') throw new Error('validation/test 표현군은 평가 전용입니다.');
  if (!result.testCase.familyId) throw new Error('학습 선별에는 familyId가 필요합니다.');
  if (!['SUCCEEDED', 'FAILED'].includes(result.status) || labInfrastructureFailure(result))
    throw new Error('검색·네트워크·Worker 장애와 미완료 응답은 학습에서 제외합니다.');
  const final = labFinalGeneration(result);
  if (review.behavior === 'negative' && !review.behaviorReasons?.length) throw new Error('부정 피드백 사유를 선택하세요.');
  if (review.behaviorReasons?.includes('model_contract_violation') &&
      !(final.step.validation?.valid === false || final.step.error && modelFaults.has(final.step.error)))
    throw new Error('최종 응답에서 검증된 모델 귀속 계약 위반이 없습니다.');
  return LabPreferenceBodySchema.parse({ version: 'preference-v1', stage: 'answer',
    familyId: labFamilyKey(result.testCase.familyId), split: 'train', ...scope,
    label: review.behavior === 'positive', reasons: review.behaviorReasons ?? [],
    prompt: final.prompt, completionRaw: JSON.stringify(final.raw), suppliedSources: final.step.suppliedSources,
    stepIndex: final.stepIndex, contextOrigin: final.contextOrigin,
  });
}

export function labPreferenceScope(run: { feedbackPolicy?: string | null; promptHash: string }): LabPreferenceScope | null {
  return run.feedbackPolicy ? { feedbackPolicy: run.feedbackPolicy, promptHash: run.promptHash } : null;
}
export function labAssertPreferenceScope(actual: LabPreferenceScope | null, selected: LabPreferenceScope) {
  if (!actual || actual.feedbackPolicy !== selected.feedbackPolicy || actual.promptHash !== selected.promptHash)
    throw new Error('선택한 평가 정책·프롬프트와 실험이 다릅니다. 범위를 다시 선택하세요.');
}
export function labTrainingLine(candidate: LabCandidate) {
  if (candidate.body.version !== 'preference-v1') throw new Error('과거 SFT 후보는 연구 이력으로만 보존합니다.');
  return { prompt: candidate.body.prompt, completion: [{ role: 'assistant' as const, content: JSON.parse(candidate.body.completionRaw) as string }], label: candidate.body.label };
}
export function labValidateSelection(candidates: LabCandidate[], policy: LabCurationExportRequest['policy'], scope: LabPreferenceScope) {
  if (!candidates.length) throw new Error('승인된 행동 피드백을 선택하세요.');
  const families: Record<string, number> = {}, reasons: Record<string, number> = {}, familyReasons: Record<string, number> = {};
  const cases = new Set<string>();
  let positive = 0;
  for (const candidate of candidates) {
    const body = candidate.body;
    if (candidate.status !== 'approved' || candidate.stale || body.version !== 'preference-v1' || body.split !== 'train')
      throw new Error('미승인·변경된 검수·과거 SFT·평가 전용 자료는 내보낼 수 없습니다.');
    labAssertPreferenceScope(body, scope);
    const key = candidate.runId + '/' + candidate.caseId;
    if (cases.has(key)) throw new Error('같은 사례를 중복 포함할 수 없습니다.');
    cases.add(key);
    positive += Number(body.label);
    families[body.familyId] = (families[body.familyId] ?? 0) + 1;
    for (const reason of body.reasons.length ? body.reasons : ['positive']) {
      reasons[reason] = (reasons[reason] ?? 0) + 1;
      const group = body.familyId + '/' + reason;
      familyReasons[group] = (familyReasons[group] ?? 0) + 1;
    }
  }
  if (positive / candidates.length < policy.minPositiveShare) throw new Error('판단 회피 편향을 줄이기 위해 긍정 사례를 함께 선택하세요.');
  if (Object.values(families).some(n => n > policy.maxPerFamily || n / candidates.length > policy.maxFamilyShare))
    throw new Error('표현군별 건수 또는 최대 비중을 초과했습니다.');
  if (Object.values(familyReasons).some(n => n > policy.maxPerFamilyError)) throw new Error('동일 표현군·사유의 대표 사례 한도를 초과했습니다.');
  return { count: candidates.length, positive, negative: candidates.length - positive, reasons, families,
    familyReasons, prompts: [scope.promptHash], feedbackPolicy: scope.feedbackPolicy };
}
