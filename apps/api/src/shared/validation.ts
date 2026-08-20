import { z } from 'zod';
import {
	AddMemberSchema,
	AdminProjectListQueryBaseSchema,
	AssetKindSchema,
	BulkDeleteProjectsSchema,
	BulkUpdateProjectStatusSchema,
	CreateExhibitionBaseSchema,
	DevAuthLoginErrorRequestSchema,
	DevAuthLoginRequestSchema,
	GameUploadCreateSessionSchema,
	GoogleAuthRequestSchema,
	ProjectStatusSchema,
	SetProjectPosterSchema,
	SubmitProjectPayloadBaseSchema,
	SwapProjectMembersSchema,
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

const CanonicalIntegerInput = z.union([
	z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
	z.string().regex(/^-?(0|[1-9]\d*)$/),
]).transform(Number).pipe(
	z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
);

const CanonicalPositiveIntegerInput = CanonicalIntegerInput.pipe(
	z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
);

export const AdminProjectListQuery = z.object({
	page: CanonicalPositiveIntegerInput.default(1),
	limit: CanonicalIntegerInput
		.pipe(z.number().int().positive())
		.transform((n) => Math.min(n, 100))
		.default(20),
	search: AdminProjectListQueryBaseSchema.shape.search
		.unwrap()
		.trim()
		.optional()
		.transform((value) => value || undefined),
	year: CanonicalIntegerInput.pipe(z.number().int().min(1000).max(9999)).optional(),
	status: AdminProjectListQueryBaseSchema.shape.status,
	sort: AdminProjectListQueryBaseSchema.shape.sort.default('createdAt'),
	order: AdminProjectListQueryBaseSchema.shape.order.default('desc'),
});

export type AdminProjectListQueryT = z.infer<typeof AdminProjectListQuery>;

// ── Project submit (all-in-one multipart payload) ────────────

export const SubmitProjectPayload = SubmitProjectPayloadBaseSchema.extend({
	exhibitionId: CanonicalPositiveIntegerInput,
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

export const SwapMembersBody = SwapProjectMembersSchema.extend({
	memberIdA: CanonicalPositiveIntegerInput,
	memberIdB: CanonicalPositiveIntegerInput,
});

// ── Poster ───────────────────────────────────────────────────

export const SetPosterBody = SetProjectPosterSchema.extend({
	assetId: CanonicalPositiveIntegerInput,
});

// ── Bulk operations ──────────────────────────────────────────

export const BulkStatusBody = BulkUpdateProjectStatusSchema;

export const BulkDeleteBody = BulkDeleteProjectsSchema;

// ── Auth ─────────────────────────────────────────────────────

export const GoogleLoginBody = GoogleAuthRequestSchema.extend({
	credential: z.string().min(1, 'Missing credential'),
});

export const DevAuthLoginBody = DevAuthLoginRequestSchema;

export const DevAuthLoginErrorBody = DevAuthLoginErrorRequestSchema;

// ── Game upload session ──────────────────────────────────────

export const GameUploadCreateSessionBody = GameUploadCreateSessionSchema.extend({
	totalBytes: CanonicalPositiveIntegerInput,
});

export const GameUploadChunkIdentityQuery = z.object({
	sourceIdentityAlgorithm: z.literal('SHA256_BLOCK_MANIFEST_V1'),
	sourceIdentity: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

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
	if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(n) || n <= 0) {
		throw new AppError(400, `Invalid ${name}`, 'VALIDATION_ERROR');
	}
	return n;
}

export function parseNonNegativeIntParam(value: string, name: string): number {
	const n = Number(value);
	if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(n)) {
		throw new AppError(400, `Invalid ${name}`, 'VALIDATION_ERROR');
	}
	return n;
}
