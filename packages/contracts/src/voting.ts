import { z } from 'zod';
export const VoteStateSchema = z.enum(['PREPARING', 'OPEN', 'PAUSED', 'CLOSED']);
export const VoteIdSchema = z.string().uuid();
const time = z.string().datetime();
export const VoteSettingsSchema = z
	.object({
		exhibitionId: z.number().int().positive(),
		title: z.string().trim().min(1).max(200),
		guidance: z.string().max(2000),
		maxSelections: z.number().int().min(1).max(100),
		state: VoteStateSchema,
		startsAt: time.nullable(),
		endsAt: time.nullable(),
		eventId: VoteIdSchema.nullable(),
	})
	.strict()
	.refine((v) => !v.startsAt || !v.endsAt || v.startsAt < v.endsAt, '마감은 시작 이후여야 합니다.');
export const VoteUpdateSchema = z
	.object({
		settings: VoteSettingsSchema,
		version: z.number().int().positive(),
		reason: z.string().trim().min(1).max(500),
	})
	.strict();
export const VoteCandidateInputSchema = z
	.object({
		title: z.string().trim().min(1).max(200),
		representationId: VoteIdSchema.optional(),
		posterId: VoteIdSchema.optional(),
		sourceProjectId: z.number().int().positive().nullable().default(null),
		active: z.boolean(),
		version: z.number().int().positive(),
		reason: z.string().trim().min(1).max(500),
	})
	.strict();
export const VoteSubmitSchema = z
	.object({ version: z.number().int().positive(), candidateIds: z.array(VoteIdSchema).min(1).max(100) })
	.strict();
export const VoteCandidateSchema = z.object({
	id: VoteIdSchema,
	title: z.string(),
	posterUrl: z.string(),
	active: z.boolean(),
	version: z.number().int(),
});
export const VoteBallotSchema = z.object({
	id: VoteIdSchema,
	createdAt: time,
	selections: z.array(VoteCandidateSchema),
});
export const VoteReceiptSchema = z.object({ id: VoteIdSchema, createdAt: time });
export const VoteDrawSchema = z.object({
	id: VoteIdSchema,
	title: z.string(),
	prize: z.boolean(),
	createdAt: time,
	receipt: VoteReceiptSchema.nullable(),
});
export const VotePublicSchema = z.object({
	privacyNotice: z.string().nullable().default(null),
	id: VoteIdSchema,
	title: z.string(),
	guidance: z.string(),
	maxSelections: z.number().int(),
	version: z.number().int(),
	state: VoteStateSchema,
	candidates: z.array(VoteCandidateSchema),
	ballot: VoteBallotSchema.nullable(),
	draw: VoteDrawSchema.nullable(),
	drawEligible: z.boolean(),
	hasDraw: z.boolean(),
});
export const VoteChangePublicSchema = z.object({
	candidate: VoteCandidateSchema.nullable().default(null),
	id: VoteIdSchema,
	version: z.number().int(),
	kind: z.string(),
	reason: z.string(),
	createdAt: time,
});
export const VoteRecordsSchema = z.object({
	page: z.number().int(),
	total: z.number().int(),
	ballots: z.array(VoteBallotSchema),
	totals: z.array(z.object({ id: VoteIdSchema, title: z.string(), count: z.number().int() })),
	changes: z.array(VoteChangePublicSchema),
	changesTotal: z.number().int(),
});
export const VotePageSchema = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1) });
export const VoteFlagSchema = z
	.object({ flagged: z.boolean(), note: z.string().max(2000), reason: z.string().trim().min(1).max(500) })
	.strict();
export const DrawItemInputSchema = z
	.object({
		id: VoteIdSchema.optional(),
		title: z.string().trim().min(1).max(200),
		prize: z.boolean(),
		remaining: z.number().int().min(0).max(1000000000).nullable(),
		weight: z.number().int().min(1).max(1000000),
		active: z.boolean(),
	})
	.strict();
export const DrawSettingsSchema = z
	.object({
		title: z.string().trim().min(1).max(200),
		mode: z.enum(['FINITE', 'WEIGHTED']),
		paused: z.boolean(),
		items: z.array(DrawItemInputSchema).min(1).max(100),
	})
	.strict()
	.refine(
		(v) => v.mode !== 'FINITE' || v.items.every((i) => i.remaining !== null),
		'유한 추첨함에는 무제한 항목을 사용할 수 없습니다.',
	);
export const DrawUpdateSchema = z
	.object({
		version: z.number().int().nonnegative(),
		settings: DrawSettingsSchema,
		reason: z.string().trim().min(1).max(500),
	})
	.strict();
export const DrawAdminSchema = z.object({
	id: VoteIdSchema,
	version: z.number().int(),
	title: z.string(),
	mode: z.enum(['FINITE', 'WEIGHTED']),
	paused: z.boolean(),
	items: z.array(DrawItemInputSchema),
});
export const VoteAdminSchema = z.object({
	id: VoteIdSchema,
	version: z.number().int(),
	settings: VoteSettingsSchema,
	candidates: z.array(VoteCandidateSchema),
	ballotCount: z.number().int(),
});
export const VoteAdminBallotSchema = VoteBallotSchema.extend({
	flagged: z.boolean(),
	note: z.string(),
	investigation: z
		.object({ ipHash: z.string(), browser: z.string(), os: z.string(), mobile: z.boolean(), expiresAt: time })
		.nullable(),
});
export const VoteAdminRecordsSchema = z.object({
	ballots: z.array(VoteAdminBallotSchema),
	total: z.number().int(),
	page: z.number().int(),
});
export const VoteSourceSchema = z.object({
	projectId: z.number().int(),
	title: z.string(),
	representationId: VoteIdSchema,
	posterUrl: z.string(),
});
export type VoteSettings = z.infer<typeof VoteSettingsSchema>;
export type VotePublic = z.infer<typeof VotePublicSchema>;
export type VoteAdmin = z.infer<typeof VoteAdminSchema>;
export type VoteRecords = z.infer<typeof VoteRecordsSchema>;
export type DrawSettings = z.infer<typeof DrawSettingsSchema>;
export type DrawAdmin = z.infer<typeof DrawAdminSchema>;

export const VotePosterSchema = z.object({ id: VoteIdSchema, posterUrl: z.string(), createdAt: time });
