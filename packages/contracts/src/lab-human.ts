import { z } from 'zod';
import { LabOutputSchema, LabResultSchema, LabSplitSchema } from './lab.js';
import { LabResearchActionSchema, LabResearchAnswerSchema } from './lab-research.js';

const text = (max: number) => z.string().max(max).regex(/^[^\u0000\uD800-\uDFFF]*$/u);
export const LabErrorTypeSchema = z.enum([
  'interpretation', 'search_decision', 'search_query', 'retrieval_failure', 'evidence_interpretation',
  'unsupported_guess', 'score', 'false_positive', 'unnecessary_abstention', 'citation', 'protocol', 'reference',
]);
export const LabVerdictSchema = z.enum(['correct', 'partial', 'incorrect', 'deferred']);
export const LabCauseSchema = z.enum(['none', 'search', 'prompt', 'policy', 'model', 'infrastructure', 'reference', 'unknown']);
export const LabCohortSchema = z.enum(['normal', 'problematic', 'ambiguous']);
export const LabBehaviorSchema = z.enum(['positive', 'negative', 'exclude']);
export const LabBehaviorReasonSchema = z.enum([
  'fabricated_fact', 'contradicts_material', 'source_distortion', 'excessive_risk',
  'topic_or_person_bias', 'unverified_assertion', 'uncertainty_mishandling', 'model_contract_violation',
]);
export const LabReviewBodySchema = z.strictObject({
  verdict: LabVerdictSchema,
  feedbackVersion: z.literal('preference-v1').optional(),
  behavior: LabBehaviorSchema.optional(),
  behaviorReasons: z.array(LabBehaviorReasonSchema).max(8).refine(v => new Set(v).size === v.length).optional(),
  errors: z.array(LabErrorTypeSchema).max(12).refine(v => new Set(v).size === v.length),
  cause: LabCauseSchema,
  cohort: LabCohortSchema.nullable(),
  rationaleFit: z.boolean().nullable(),
  interpretationSuccess: z.boolean().nullable(),
  sourceChecks: z.array(z.strictObject({ sourceId: z.string(), relevant: z.boolean().nullable(), supports: z.boolean().nullable() })).max(16),
  notes: text(4000),
  blind: z.boolean(),
  correction: LabResearchAnswerSchema.partial(),
  correctedAction: LabResearchActionSchema.nullable(),
  reusedReference: z.boolean(),
}).superRefine((v, ctx) => {
  if (v.behavior === 'negative' && !v.behaviorReasons?.length)
    ctx.addIssue({ code: 'custom', message: '부정 피드백의 사유를 선택하세요.', path: ['behaviorReasons'] });
  if (v.behavior !== 'negative' && v.behaviorReasons?.length)
    ctx.addIssue({ code: 'custom', message: '부정 피드백에만 행동 사유를 지정하세요.', path: ['behaviorReasons'] });
});
export const LabSaveReviewSchema = z.strictObject({
  previousReviewId: z.uuid().nullable(), resultHash: z.string().length(64), body: LabReviewBodySchema,
}).refine(v => v.body.feedbackVersion === 'preference-v1' && !!v.body.behavior &&
  !Object.keys(v.body.correction).length && !v.body.correctedAction && !v.body.reusedReference,
  '신규 검수는 독립적인 행동 피드백을 기록합니다. 교정 응답은 학습에 사용하지 않습니다.');
export const LabHumanReviewSchema = z.object({
  id: z.uuid(), runId: z.uuid(), caseId: z.string(), revision: z.number().int(), actorId: z.number().int(),
  createdAt: z.iso.datetime(), resultHash: z.string(), body: LabReviewBodySchema,
});
export const LabObjectiveSchema = z.enum(['A', 'B', 'C']);
export const LabMessageSchema = z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() });
export const LabLegacyCandidateBodySchema = z.object({
  version: z.literal('human-curation-v1'), objective: LabObjectiveSchema,
  familyId: z.string(), split: LabSplitSchema, cohort: LabCohortSchema,
  errors: z.array(LabErrorTypeSchema), retention: z.boolean(),
  messages: z.array(LabMessageSchema), suppliedSources: z.array(z.object({ id: z.string(), title: z.string(), snippet: z.string() })),
  contextOrigin: z.string(), stepIndex: z.number().int().nonnegative().nullable(),
  reusedReference: z.boolean(), warnings: z.array(z.string()),
});
export const LabPreferenceBodySchema = z.object({
  version: z.literal('preference-v1'), stage: z.literal('answer'), familyId: z.string(), split: z.literal('train'),
  feedbackPolicy: z.string().min(1), promptHash: z.string(), label: z.boolean(),
  reasons: z.array(LabBehaviorReasonSchema),
  prompt: z.array(z.object({ role: z.enum(['system', 'user', 'assistant', 'tool']), content: z.string(),
    tool_calls: z.array(z.unknown()).optional(), tool_call_id: z.string().optional(), tool_name: z.string().optional() })),
  // Encoded once for PostgreSQL jsonb, decoded only at the JSONL boundary. Invalid JSON/Unicode remains exact.
  completionRaw: z.string(),
  suppliedSources: z.array(z.object({ id: z.string(), title: z.string(), snippet: z.string() })),
  stepIndex: z.number().int().nonnegative(), contextOrigin: z.enum(['research', 'chat']),
});
export const LabCandidateBodySchema = z.discriminatedUnion('version', [LabLegacyCandidateBodySchema, LabPreferenceBodySchema]);
export const LabPreferenceScopeSchema = z.strictObject({ feedbackPolicy: text(4000).min(1), promptHash: z.string().length(64) });
export const LabApproveFeedbackSchema = z.strictObject({
  reviewIds: z.array(z.uuid()).min(1).max(1000).refine(v => new Set(v).size === v.length),
  scope: LabPreferenceScopeSchema,
});
export const LabFeedbackItemSchema = z.object({
  review: LabHumanReviewSchema, nickname: z.string(), familyId: z.string().nullable(),
  eligible: z.boolean(), exclusion: z.string().nullable(), candidateId: z.uuid().nullable(),
});
export const LabCandidateSchema = z.object({
  id: z.uuid(), reviewId: z.uuid(), runId: z.uuid(), caseId: z.string(), actorId: z.number().int(), createdAt: z.iso.datetime(),
  contentHash: z.string(), status: z.enum(['draft', 'approved', 'rejected']), body: LabCandidateBodySchema,
  decisions: z.array(z.object({ actorId: z.number().int(), at: z.iso.datetime(), decision: z.enum(['approved', 'rejected']),
    grounded: z.boolean(), familyVerified: z.boolean() })), stale: z.boolean(),
});
export const LabReviewBundleSchema = z.object({ resultHash: z.string(), reviews: z.array(LabHumanReviewSchema),
  candidates: z.array(LabCandidateSchema), effectiveSplit: LabSplitSchema.nullable(), splitError: z.string().nullable() });
export const LabCurationPolicySchema = z.strictObject({
  maxPerFamily: z.number().int().min(1).max(10).default(3),
  maxPerFamilyError: z.number().int().min(1).max(3).default(1),
  maxFamilyShare: z.number().min(0.05).max(1).default(0.5),
  minPositiveShare: z.number().min(0.1).max(1).default(0.2),
});
export const LabCurationExportRequestSchema = z.strictObject({
  kind: LabSplitSchema, candidateIds: z.array(z.uuid()).max(1000).default([]),
  scope: LabPreferenceScopeSchema, policy: LabCurationPolicySchema, approved: z.literal(true),
});
export const LabCurationExportSchema = z.object({
  id: z.uuid(), runId: z.uuid(), actorId: z.number().int(), createdAt: z.iso.datetime(), kind: LabSplitSchema,
  files: z.array(z.object({ filename: z.string(), content: z.string() })), manifest: z.record(z.string(), z.unknown()),
});
export const LabMetricSchema = z.object({
  key: z.string(), label: z.string(), value: z.number().nullable(), numerator: z.number(), denominator: z.number(),
  missing: z.number(), unit: z.enum(['rate', 'score', 'ms']),
});
export const LabHumanMetricsSchema = z.object({
  total: z.number(), reviewed: z.number(), staleReviews: z.number(), failed: z.number(), cancelled: z.number(), pending: z.number(),
  infrastructure: z.number(), unknownCohort: z.number(), riskThreshold: z.number(), metrics: z.array(LabMetricSchema),
});
export const LabCurationOverviewSchema = z.object({
  scope: LabPreferenceScopeSchema.nullable(), feedback: z.array(LabFeedbackItemSchema),
  metrics: LabHumanMetricsSchema, candidates: z.array(LabCandidateSchema),
  exports: z.array(LabCurationExportSchema.omit({ files: true })),
});
export const LabReviewSnapshotSchema = z.object({ result: LabResultSchema, body: LabReviewBodySchema });
export type LabReviewBody = z.infer<typeof LabReviewBodySchema>;
export type LabHumanReview = z.infer<typeof LabHumanReviewSchema>;
export type LabSaveReview = z.infer<typeof LabSaveReviewSchema>;
export type LabCandidate = z.infer<typeof LabCandidateSchema>;
export type LabCandidateBody = z.infer<typeof LabCandidateBodySchema>;
export type LabReviewBundle = z.infer<typeof LabReviewBundleSchema>;
export type LabCurationExportRequest = z.infer<typeof LabCurationExportRequestSchema>;
export type LabCurationExport = z.infer<typeof LabCurationExportSchema>;
export type LabHumanMetrics = z.infer<typeof LabHumanMetricsSchema>;
export type LabCurationOverview = z.infer<typeof LabCurationOverviewSchema>;
export type LabCorrection = z.infer<typeof LabOutputSchema>;

// Derived evaluations never change the generation snapshot reviewed by a person.
export function labReviewResult(result: z.infer<typeof LabResultSchema>) {
  const { bertScore: _derived, ...original } = result;
  return original;
}
export const LabRiskThresholdSchema = z.coerce.number().int().min(0).max(100).default(50);

export type LabPreferenceBody = z.infer<typeof LabPreferenceBodySchema>;
export type LabApproveFeedback = z.infer<typeof LabApproveFeedbackSchema>;
export type LabPreferenceScope = z.infer<typeof LabPreferenceScopeSchema>;
