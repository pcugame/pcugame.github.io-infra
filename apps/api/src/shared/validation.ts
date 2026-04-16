import { z } from 'zod';

// ── Enums (matching Prisma) ──────────────────────────────────

export const ProjectStatusEnum = z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']);
export const AssetKindEnum = z.enum(['THUMBNAIL', 'IMAGE', 'POSTER', 'GAME', 'VIDEO']);

// ── Exhibition ──────────────────────────────────────────────

export const CreateExhibitionBody = z.object({
	year: z.number().int().min(2021).max(2100),
	title: z.string().max(100).optional().default(''),
	isUploadEnabled: z.boolean().optional().default(true),
	sortOrder: z.number().int().min(0).optional().default(0),
});

export const UpdateExhibitionBody = z.object({
	title: z.string().max(100).optional(),
	isUploadEnabled: z.boolean().optional(),
	sortOrder: z.number().int().min(0).optional(),
});

// ── Project update ───────────────────────────────────────────

export const UpdateProjectBody = z.object({
	title: z.string().min(1).max(120).optional(),
	summary: z.string().max(300).optional(),
	description: z.string().max(5000).optional(),
	isIncomplete: z.boolean().optional(),
	status: ProjectStatusEnum.optional(),
	sortOrder: z.number().int().min(0).optional(),
});

// ── Project submit (all-in-one multipart payload) ────────────

const SubmitMember = z.object({
	name: z.string().min(1).max(50),
	studentId: z.string().min(1).max(20),
	sortOrder: z.number().int().min(0).optional(),
	userId: z.number().int().positive().optional(),
});

export const SubmitProjectPayload = z.object({
	exhibitionId: z.coerce.number().int().positive('Invalid exhibition ID'),
	title: z.string().min(1).max(120),
	summary: z.string().max(300).optional().default(''),
	description: z.string().max(5000).optional().default(''),
	autoPublish: z.boolean().optional().default(false),
	members: z.array(SubmitMember).min(1, 'At least one member required'),
});

export type SubmitProjectPayloadT = z.infer<typeof SubmitProjectPayload>;

// ── Member ───────────────────────────────────────────────────

export const AddMemberBody = z.object({
	name: z.string().min(1).max(50),
	studentId: z.string().min(1).max(20),
	sortOrder: z.number().int().min(0).optional().default(0),
});

export const UpdateMemberBody = z.object({
	name: z.string().min(1).max(50).optional(),
	studentId: z.string().min(1).max(20).optional(),
	sortOrder: z.number().int().min(0).optional(),
	userId: z.coerce.number().int().positive().nullable().optional(),
});

export const SwapMembersBody = z.object({
	memberIdA: z.coerce.number().int().positive(),
	memberIdB: z.coerce.number().int().positive(),
});

// ── Poster ───────────────────────────────────────────────────

export const SetPosterBody = z.object({
	assetId: z.coerce.number().int().positive(),
});

// ── Bulk operations ──────────────────────────────────────────

export const BulkStatusBody = z.object({
	ids: z.array(z.number().int().positive()).min(1).max(500),
	status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']),
});

export const BulkDeleteBody = z.object({
	ids: z.array(z.number().int().positive()).min(1).max(500),
});

// ── Auth ─────────────────────────────────────────────────────

export const GoogleLoginBody = z.object({
	credential: z.string().min(1, 'Missing credential'),
});

// ── Helper ───────────────────────────────────────────────────

import { AppError } from './errors.js';

export function parseBody<T>(schema: z.ZodType<T>, data: unknown): T {
	const result = schema.safeParse(data);
	if (!result.success) {
		const details = result.error.flatten().fieldErrors;
		throw new AppError(400, 'Validation failed', 'VALIDATION_ERROR', details);
	}
	return result.data;
}

export function parseIntParam(value: string, name = 'ID'): number {
	const n = Number(value);
	if (!Number.isInteger(n) || n <= 0) {
		throw new AppError(400, `Invalid ${name}`, 'VALIDATION_ERROR');
	}
	return n;
}
