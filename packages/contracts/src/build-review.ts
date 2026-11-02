import { z } from 'zod';
export const BuildInspectionSchema = z.object({
	version: z.literal('build-package-v1'),
	outcome: z.enum(['PASS', 'REVIEW', 'REJECT']),
	engines: z.array(z.string()),
	evidence: z.array(z.string()),
	reasons: z.array(z.string()),
	entryCandidates: z.array(z.string()),
	entryPath: z.string().nullable(),
	files: z.array(z.object({ path: z.string(), bytes: z.number().nonnegative() })),
});
export const BuildReviewSchema = z.object({
	id: z.string(),
	sessionId: z.string(),
	projectId: z.number().int().positive(),
	generation: z.number().int().positive(),
	sourceIdentity: z.string(),
	validatorVersion: z.string(),
	inspection: BuildInspectionSchema,
	kind: z.enum(['GAME', 'WEBGL']),
	originalName: z.string(),
	totalBytes: z.number().positive(),
	decision: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']),
	version: z.number().int().positive(),
	decidedBy: z.number().nullable(),
	reason: z.string().nullable(),
	entryPath: z.string().nullable(),
	createdAt: z.string(),
	decidedAt: z.string().nullable(),
});
export const BuildReviewDecisionSchema = z
	.object({
		decision: z.enum(['APPROVED', 'REJECTED']),
		reason: z.string().trim().min(1).max(2000),
		version: z.number().int().positive(),
		entryPath: z.string().min(1).max(4096).optional(),
	})
	.strict();
export type BuildReview = z.infer<typeof BuildReviewSchema>;
export type BuildReviewDecision = z.infer<typeof BuildReviewDecisionSchema>;

export const BuildReviewSummarySchema = BuildReviewSchema.omit({ inspection: true });
export type BuildReviewSummary = z.infer<typeof BuildReviewSummarySchema>;
