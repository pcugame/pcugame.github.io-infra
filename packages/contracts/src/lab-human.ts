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
export const LabReviewBodySchema = z.strictObject({
  verdict: LabVerdictSchema,
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
  if (['incorrect', 'partial'].includes(v.verdict) && !v.errors.length)
    ctx.addIssue({ code: 'custom', message: '부분 정답·오답에는 오류 유형을 선택하세요.', path: ['errors'] });
  if (v.verdict === 'correct' && v.errors.length)
    ctx.addIssue({ code: 'custom', message: '정답에는 오류 유형을 지정할 수 없습니다.', path: ['errors'] });
});
export const LabSaveReviewSchema = z.strictObject({
  previousReviewId: z.uuid().nullable(), resultHash: z.string().length(64), body: LabReviewBodySchema,
});
export const LabHumanReviewSchema = z.object({
  id: z.uuid(), runId: z.uuid(), caseId: z.string(), revision: z.number().int(), actorId: z.number().int(),
  createdAt: z.iso.datetime(), resultHash: z.string(), body: LabReviewBodySchema,
});
export const LabObjectiveSchema = z.enum(['A', 'B', 'C']);
export const LabCreateCandidateSchema = z.strictObject({ reviewId: z.uuid(), objective: LabObjectiveSchema,
  stepIndex: z.number().int().nonnegative().optional() });
export const LabCandidateDecisionSchema = z.strictObject({
  decision: z.enum(['approved', 'rejected']), contentHash: z.string().length(64),
  grounded: z.boolean(), familyVerified: z.boolean(),
}).refine(v => v.decision !== 'approved' || (v.grounded && v.familyVerified), '근거 범위와 표현군을 확인한 뒤 승인하세요.');
export const LabMessageSchema = z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() });
export const LabCandidateBodySchema = z.object({
  version: z.literal('human-curation-v1'), objective: LabObjectiveSchema,
  familyId: z.string(), split: LabSplitSchema, cohort: LabCohortSchema,
  errors: z.array(LabErrorTypeSchema), retention: z.boolean(),
  messages: z.array(LabMessageSchema), suppliedSources: z.array(z.object({ id: z.string(), title: z.string(), snippet: z.string() })),
  contextOrigin: z.string(), stepIndex: z.number().int().nonnegative().nullable(),
  reusedReference: z.boolean(), warnings: z.array(z.string()),
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
  minRetentionShare: z.number().min(0.1).max(1).default(0.2),
  minNormalShare: z.number().min(0).max(1).default(0.1),
  minAmbiguousShare: z.number().min(0).max(1).default(0.1),
});
export const LabCurationExportRequestSchema = z.strictObject({
  kind: LabSplitSchema, candidateIds: z.array(z.uuid()).max(1000).default([]),
  policy: LabCurationPolicySchema, approved: z.literal(true),
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
  metrics: LabHumanMetricsSchema, candidates: z.array(LabCandidateSchema),
  exports: z.array(LabCurationExportSchema.omit({ files: true })),
});
export const LabReviewSnapshotSchema = z.object({ result: LabResultSchema, body: LabReviewBodySchema });
export type LabReviewBody = z.infer<typeof LabReviewBodySchema>;
export type LabHumanReview = z.infer<typeof LabHumanReviewSchema>;
export type LabSaveReview = z.infer<typeof LabSaveReviewSchema>;
export type LabCandidate = z.infer<typeof LabCandidateSchema>;
export type LabCandidateBody = z.infer<typeof LabCandidateBodySchema>;
export type LabCreateCandidate = z.infer<typeof LabCreateCandidateSchema>;
export type LabCandidateDecision = z.infer<typeof LabCandidateDecisionSchema>;
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
