import { z } from 'zod';

export const LabBertScoreIdentitySchema = z.object({
  model: z.string(), revision: z.string().regex(/^[a-f0-9]{40}$/), layers: z.number().int(),
  device: z.literal('cpu'), threads: z.number().int(), batchSize: z.number().int(),
  idf: z.literal(false), rescaleWithBaseline: z.literal(false), useFastTokenizer: z.boolean(),
  maxTokens: z.number().int(), versions: z.record(z.string(), z.string()), configHash: z.string().length(64),
});
export const LabBertScoreStatusSchema = z.enum(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED']);
const similarity = z.number().min(-1).max(1.00001);
export const LabBertScoreResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('SUCCEEDED'), precision: similarity, recall: similarity, f1: similarity,
    identity: LabBertScoreIdentitySchema }),
  z.object({ status: z.literal('SKIPPED'), reason: z.enum(['EMPTY_REASON', 'TOKEN_LIMIT']), identity: LabBertScoreIdentitySchema }),
]);
export const LabBertScoreSchema = z.object({
  status: LabBertScoreStatusSchema, precision: similarity.nullable(), recall: similarity.nullable(), f1: similarity.nullable(),
  reason: z.string().nullable(), attempts: z.number().int(), inputHash: z.string(),
  identity: LabBertScoreIdentitySchema.nullable(), completedAt: z.iso.datetime().nullable(),
});
export const LabBertScoreSummarySchema = z.object({
  measured: z.number(), missing: z.number(), pending: z.number(), running: z.number(), failed: z.number(),
  skipped: z.number(), cancelled: z.number(), waiting: z.number(),
  precision: z.number().nullable(), recall: z.number().nullable(), f1: z.number().nullable(),
});
export type LabBertScore = z.infer<typeof LabBertScoreSchema>;
export type LabBertScoreResponse = z.infer<typeof LabBertScoreResponseSchema>;
export type LabBertScoreSummary = z.infer<typeof LabBertScoreSummarySchema>;

export function labBertScoreSummary(results: { bertScore?: LabBertScore | null }[]): LabBertScoreSummary {
  const scores = results.flatMap(r => r.bertScore ? [r.bertScore] : []);
  const measured = scores.filter(s => s.status === 'SUCCEEDED');
  const mean = (key: 'precision' | 'recall' | 'f1') => measured.length
    ? measured.reduce((sum, s) => sum + s[key]!, 0) / measured.length : null;
  const count = (status: LabBertScore['status']) => scores.filter(s => s.status === status).length;
  return { measured: measured.length, missing: results.length - measured.length,
    pending: count('PENDING'), running: count('RUNNING'), failed: count('FAILED'), skipped: count('SKIPPED'),
    cancelled: count('CANCELLED'), waiting: results.length - scores.length,
    precision: mean('precision'), recall: mean('recall'), f1: mean('f1') };
}
