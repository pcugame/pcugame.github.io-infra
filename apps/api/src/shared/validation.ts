import { z } from 'zod';
import {
	AddMemberSchema,
	AssetKindSchema,
	CreateExhibitionBaseSchema,
	ProjectStatusSchema,
	SubmitProjectPayloadBaseSchema,
	UpdateExhibitionBaseSchema,
	UpdateMemberBaseSchema,
	UpdateProjectBaseSchema,
} from '@pcu/contracts';

// ── Enums (matching Prisma) ──────────────────────────────────

export const ProjectStatusEnum = ProjectStatusSchema;
export const AssetKindEnum = AssetKindSchema;

// ── Exhibition ──────────────────────────────────────────────

export const CreateExhibitionBody = CreateExhibitionBaseSchema.extend({
	title: CreateExhibitionBaseSchema.shape.title.default(''),
	isUploadEnabled: CreateExhibitionBaseSchema.shape.isUploadEnabled.default(true),
	sortOrder: CreateExhibitionBaseSchema.shape.sortOrder.default(0),
});

export const UpdateExhibitionBody = UpdateExhibitionBaseSchema;

// ── Project update ───────────────────────────────────────────

export const UpdateProjectBody = UpdateProjectBaseSchema;

export const AdminProjectListQuery = z.object({
	page: z.coerce.number().int().positive().default(1),
	limit: z.coerce.number().int().positive().transform((n) => Math.min(n, 100)).default(20),
	search: z.string().trim().max(100).optional().transform((value) => value || undefined),
	year: z.coerce.number().int().optional(),
	status: ProjectStatusEnum.optional(),
	sort: z.enum(['createdAt', 'title', 'year', 'status']).default('createdAt'),
	order: z.enum(['asc', 'desc']).default('desc'),
});

export type AdminProjectListQueryT = z.infer<typeof AdminProjectListQuery>;

// ── Project submit (all-in-one multipart payload) ────────────

export const SubmitProjectPayload = SubmitProjectPayloadBaseSchema.extend({
	exhibitionId: z.coerce.number().int().positive('Invalid exhibition ID'),
	summary: SubmitProjectPayloadBaseSchema.shape.summary.default(''),
	description: SubmitProjectPayloadBaseSchema.shape.description.default(''),
});

export type SubmitProjectPayloadT = z.infer<typeof SubmitProjectPayload>;

// ── Member ───────────────────────────────────────────────────

export const AddMemberBody = AddMemberSchema.extend({
	sortOrder: AddMemberSchema.shape.sortOrder.default(0),
});

export const UpdateMemberBody = UpdateMemberBaseSchema.extend({
	userId: z.never().optional(),
}).transform((body) => ({
	...(body.name !== undefined ? { name: body.name } : {}),
	...(body.studentId !== undefined ? { studentId: body.studentId } : {}),
	...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
}));

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
	status: ProjectStatusEnum,
});

export const BulkDeleteBody = z.object({
	ids: z.array(z.number().int().positive()).min(1).max(500),
});

// ── Auth ─────────────────────────────────────────────────────

export const GoogleLoginBody = z.object({
	credential: z.string().min(1, 'Missing credential'),
});

export const DevAuthLoginBody = z.object({
	role: z.enum(['USER', 'OPERATOR', 'ADMIN']),
});

export const DevAuthLoginErrorBody = z.object({
	scenario: z.enum([
		'domain-not-allowed',
		'google-api-unavailable',
		'invalid-google-token',
		'missing-google-payload',
		'api-server-error',
	]),
});

// ── Helper ───────────────────────────────────────────────────

import { AppError } from './errors.js';

export function parseBody<TSchema extends z.ZodType>(
	schema: TSchema,
	data: unknown,
): z.output<TSchema> {
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
