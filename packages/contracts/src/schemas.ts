import { z } from 'zod';
import { MAX_NEW_PROJECT_TITLE_BYTES, utf8ByteLength } from './filename-policy.js';

export const ProjectStatusSchema = z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']);
const MutableProjectStatusSchema = z.enum(['PUBLISHED', 'ARCHIVED']);
export const AssetKindSchema = z.enum(['THUMBNAIL', 'IMAGE', 'POSTER', 'GAME', 'VIDEO', 'WEBGL', 'DOCUMENT', 'ATTACHMENT']);
export const UserRoleSchema = z.enum(['USER', 'OPERATOR', 'ADMIN']);
export const AdminProjectListSortSchema = z.enum(['createdAt', 'title', 'year', 'status']);
export const SortOrderSchema = z.enum(['asc', 'desc']);
export const DevAuthErrorScenarioSchema = z.enum([
	'domain-not-allowed',
	'google-api-unavailable',
	'invalid-google-token',
	'missing-google-payload',
	'api-server-error',
]);

const SafePositiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const SafeNonNegativeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const ProjectMemberInputSchema = z.object({
	name: z.string().min(1).max(50),
	studentId: z.string().min(1).max(20),
	sortOrder: SafeNonNegativeIntegerSchema.optional(),
	userId: SafePositiveIntegerSchema.optional(),
});

export const ProjectSubmissionTitleSchema = z.string()
	.min(1, '제목을 입력하세요.')
	.refine((title) => utf8ByteLength(title) <= MAX_NEW_PROJECT_TITLE_BYTES, {
		message: `작품 제목은 UTF-8 기준 ${MAX_NEW_PROJECT_TITLE_BYTES}바이트 이하여야 합니다.`,
	});

export const SubmitProjectPayloadBaseSchema = z.object({
	exhibitionId: SafePositiveIntegerSchema,
	title: ProjectSubmissionTitleSchema,
	summary: z.string().max(300).optional(),
	description: z.string().max(5000).optional(),
	members: z.array(ProjectMemberInputSchema).min(1),
	manifest: z.array(z.object({
		kind: z.enum(['GAME', 'WEBGL', 'VIDEO', 'IMAGE', 'POSTER', 'DOCUMENT', 'ATTACHMENT']),
		slot: z.string().regex(/^(game|webgl|poster|video:[0-9]+|image:[0-9]+|document:[0-9]+|attachment:[0-9]+)$/),
		clientToken: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
		required: z.literal(true).default(true),
	}).strict()).max(250).default([]),
});

export const UpdateProjectBaseSchema = z.object({
	title: z.string().min(1).max(120).optional(),
	summary: z.string().max(300).optional(),
	description: z.string().max(5000).optional(),
	isIncomplete: z.boolean().optional(),
	status: MutableProjectStatusSchema.optional(),
	sortOrder: SafeNonNegativeIntegerSchema.optional(),
});

export const AdminProjectListQueryBaseSchema = z.object({
	page: SafePositiveIntegerSchema.optional(),
	limit: SafePositiveIntegerSchema.optional(),
	search: z.string().max(100).optional(),
	year: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).optional(),
	status: ProjectStatusSchema.optional(),
	sort: AdminProjectListSortSchema.optional(),
	order: SortOrderSchema.optional(),
});

export const BulkUpdateProjectStatusSchema = z.object({
	ids: z.array(SafePositiveIntegerSchema).min(1).max(500),
	status: MutableProjectStatusSchema,
});

export const BulkDeleteProjectsSchema = z.object({
	ids: z.array(SafePositiveIntegerSchema).min(1).max(500),
});

export const SetProjectPosterSchema = z.object({
	assetId: SafePositiveIntegerSchema,
});

export const CreateExhibitionBaseSchema = z.object({
	year: z.number().int().min(2021).max(2100),
	title: z.string().max(100).optional(),
	isModificationEnabled: z.boolean().optional(),
	isUploadEnabled: z.boolean().optional(),
	sortOrder: SafeNonNegativeIntegerSchema.optional(),
}).refine((value) => value.isModificationEnabled === undefined || value.isUploadEnabled === undefined
	|| value.isModificationEnabled === value.isUploadEnabled, { message: 'Modification flags disagree', path: ['isModificationEnabled'] });

export const UpdateExhibitionBaseSchema = z.object({
	title: z.string().max(100).optional(),
	isModificationEnabled: z.boolean().optional(),
	isUploadEnabled: z.boolean().optional(),
	sortOrder: SafeNonNegativeIntegerSchema.optional(),
}).refine((value) => value.isModificationEnabled === undefined || value.isUploadEnabled === undefined
	|| value.isModificationEnabled === value.isUploadEnabled, { message: 'Modification flags disagree', path: ['isModificationEnabled'] });

export const AddMemberSchema = z.object({
	name: z.string().min(1).max(50),
	studentId: z.string().min(1).max(20),
	sortOrder: SafeNonNegativeIntegerSchema.optional(),
});

export const UpdateMemberBaseSchema = z.object({
	name: z.string().min(1).max(50).optional(),
	studentId: z.string().min(1).max(20).optional(),
	sortOrder: SafeNonNegativeIntegerSchema.optional(),
});

export const SwapProjectMembersSchema = z.object({
	memberIdA: SafePositiveIntegerSchema,
	memberIdB: SafePositiveIntegerSchema,
});

export const GoogleAuthRequestSchema = z.object({
	credential: z.string().min(1),
});

export const DevAuthLoginRequestSchema = z.object({
	role: UserRoleSchema,
});

export const DevAuthLoginErrorRequestSchema = z.object({
	scenario: DevAuthErrorScenarioSchema,
});

export type ProjectMemberInputSchemaInput = z.infer<typeof ProjectMemberInputSchema>;
export type SubmitProjectPayloadBaseSchemaInput = z.infer<typeof SubmitProjectPayloadBaseSchema>;
export type UpdateProjectBaseSchemaInput = z.infer<typeof UpdateProjectBaseSchema>;
export type AdminProjectListQueryBaseSchemaInput = z.infer<typeof AdminProjectListQueryBaseSchema>;
export type BulkUpdateProjectStatusSchemaInput = z.infer<typeof BulkUpdateProjectStatusSchema>;
export type BulkDeleteProjectsSchemaInput = z.infer<typeof BulkDeleteProjectsSchema>;
export type SetProjectPosterSchemaInput = z.infer<typeof SetProjectPosterSchema>;
export type CreateExhibitionBaseSchemaInput = z.infer<typeof CreateExhibitionBaseSchema>;
export type UpdateExhibitionBaseSchemaInput = z.infer<typeof UpdateExhibitionBaseSchema>;
export type AddMemberSchemaInput = z.infer<typeof AddMemberSchema>;
export type UpdateMemberBaseSchemaInput = z.infer<typeof UpdateMemberBaseSchema>;
export type SwapProjectMembersSchemaInput = z.infer<typeof SwapProjectMembersSchema>;
export type GoogleAuthRequestSchemaInput = z.infer<typeof GoogleAuthRequestSchema>;
export type DevAuthLoginRequestSchemaInput = z.infer<typeof DevAuthLoginRequestSchema>;
export type DevAuthLoginErrorRequestSchemaInput = z.infer<typeof DevAuthLoginErrorRequestSchema>;

export const SetProjectVideoOrderSchema = z.object({
	expectedOrder: z.array(z.number().int().positive()),
	order: z.array(z.number().int().positive()),
}).strict();
