import { UserRoleSchema, ProjectStatusSchema, AssetKindSchema, VisibilitySchema } from './enums.js';
import { PublicationCommandSchema } from './publication.js';
import { z } from 'zod';
import { PlatformsSchema, HardwareRequirementsSchema } from './project-requirements.js';
import { ExternalLinksSchema } from './external-links.js';
import { MAX_NEW_PROJECT_TITLE_BYTES, utf8ByteLength } from './filename-policy.js';

export { UserRoleSchema, ProjectStatusSchema, AssetKindSchema, VisibilitySchema };

const MutableProjectStatusSchema = z.enum(['PUBLISHED', 'ARCHIVED']);
export const AdminProjectListSortSchema = z.enum(['createdAt', 'title', 'year', 'status']);
export type AdminProjectListSort = z.input<typeof AdminProjectListSortSchema>;
export const SortOrderSchema = z.enum(['asc', 'desc']);
export type SortOrder = z.input<typeof SortOrderSchema>;
export const DevAuthErrorScenarioSchema = z.enum([
	'domain-not-allowed',
	'google-api-unavailable',
	'invalid-google-token',
	'missing-google-payload',
	'api-server-error',
]);
export type DevAuthErrorScenario = z.input<typeof DevAuthErrorScenarioSchema>;

const SafePositiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const SafeNonNegativeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const ProjectMemberInputSchema = z.object({
	name: z.string().min(1).max(50),
	studentId: z.string().min(1).max(20),
	sortOrder: SafeNonNegativeIntegerSchema.optional(),
	userId: SafePositiveIntegerSchema.optional(),
});
export type ProjectMemberInputSchemaInput = z.input<typeof ProjectMemberInputSchema>;

export const ProjectSubmissionTitleSchema = z.string()
	.min(1, '제목을 입력하세요.')
	.refine((title) => utf8ByteLength(title) <= MAX_NEW_PROJECT_TITLE_BYTES, {
		message: `작품 제목은 UTF-8 기준 ${MAX_NEW_PROJECT_TITLE_BYTES}바이트 이하여야 합니다.`,
	});

export const SubmitProjectPayloadBaseSchema = z.object({
 allowDuplicateTitle: z.boolean().optional(),
	visibility: VisibilitySchema.optional(),
	exhibitionId: SafePositiveIntegerSchema,
	title: ProjectSubmissionTitleSchema,
	summary: z.string().max(300).optional(),
	description: z.string().max(5000).optional(),
	externalLinks: ExternalLinksSchema.optional(),
	platforms: PlatformsSchema.optional(),
	hardwareRequirements: HardwareRequirementsSchema.optional(),
	members: z.array(ProjectMemberInputSchema).min(1),
	manifest: z.array(z.object({
		kind: z.enum(['GAME', 'WEBGL', 'VIDEO', 'IMAGE', 'POSTER', 'DOCUMENT', 'ATTACHMENT']),
		slot: z.string().regex(/^(game|webgl|poster|video:[0-9]+|image:[0-9]+|document:[0-9]+|attachment:[0-9]+)$/),
		clientToken: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
		required: z.literal(true).default(true),
	}).strict()).max(250).default([]),
});
export type SubmitProjectPayloadBaseSchemaInput = z.input<typeof SubmitProjectPayloadBaseSchema>;
export type SubmitProjectPayload = z.input<typeof SubmitProjectPayloadBaseSchema>;
/** Validated submission after manifest and required defaults have been applied. */
export type SubmitProjectPayloadOutput = z.output<typeof SubmitProjectPayloadBaseSchema>;

export const UpdateProjectBaseSchema = z.object({
 publication: PublicationCommandSchema.optional(),
	visibility: VisibilitySchema.optional(),
	title: z.string().min(1).max(120).optional(),
	summary: z.string().max(300).optional(),
	description: z.string().max(5000).optional(),
	externalLinks: ExternalLinksSchema.optional(),
	platforms: PlatformsSchema.optional(),
	hardwareRequirements: HardwareRequirementsSchema.optional(),
	isIncomplete: z.boolean().optional(),
	status: MutableProjectStatusSchema.optional(),
	sortOrder: SafeNonNegativeIntegerSchema.optional(),
});
export type UpdateProjectBaseSchemaInput = z.input<typeof UpdateProjectBaseSchema>;
export type UpdateProjectRequest = z.input<typeof UpdateProjectBaseSchema>;

export const AdminProjectListQueryBaseSchema = z.object({
	page: SafePositiveIntegerSchema.optional(),
	limit: SafePositiveIntegerSchema.optional(),
	search: z.string().max(100).optional(),
	year: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).optional(),
	status: ProjectStatusSchema.optional(),
	sort: AdminProjectListSortSchema.optional(),
	order: SortOrderSchema.optional(),
});
export type AdminProjectListQueryBaseSchemaInput = z.input<typeof AdminProjectListQueryBaseSchema>;
export type AdminProjectListQuery = z.input<typeof AdminProjectListQueryBaseSchema>;

export const BulkUpdateProjectStatusSchema = z.object({
	ids: z.array(SafePositiveIntegerSchema).min(1).max(500),
	status: MutableProjectStatusSchema,
});
export type BulkUpdateProjectStatusSchemaInput = z.input<typeof BulkUpdateProjectStatusSchema>;
export type BulkUpdateProjectStatusRequest = z.input<typeof BulkUpdateProjectStatusSchema>;

export const BulkDeleteProjectsSchema = z.object({
	ids: z.array(SafePositiveIntegerSchema).min(1).max(500),
});
export type BulkDeleteProjectsSchemaInput = z.input<typeof BulkDeleteProjectsSchema>;
export type BulkDeleteProjectsRequest = z.input<typeof BulkDeleteProjectsSchema>;

export const SetProjectPosterSchema = z.object({
	assetId: SafePositiveIntegerSchema,
});
export type SetProjectPosterSchemaInput = z.input<typeof SetProjectPosterSchema>;
export type SetProjectPosterRequest = z.input<typeof SetProjectPosterSchema>;

export const CreateExhibitionBaseSchema = z.object({
	visibility: VisibilitySchema.optional(),
	year: z.number().int().min(2021).max(2100),
	title: z.string().max(100).optional(),
	isModificationEnabled: z.boolean().optional(),
	isUploadEnabled: z.boolean().optional(),
	sortOrder: SafeNonNegativeIntegerSchema.optional(),
}).refine((value) => value.isModificationEnabled === undefined || value.isUploadEnabled === undefined
	|| value.isModificationEnabled === value.isUploadEnabled, { message: 'Modification flags disagree', path: ['isModificationEnabled'] });
export type CreateExhibitionBaseSchemaInput = z.input<typeof CreateExhibitionBaseSchema>;
export type CreateExhibitionRequest = z.input<typeof CreateExhibitionBaseSchema>;

export const UpdateExhibitionBaseSchema = z.object({
	visibility: VisibilitySchema.optional(),
	title: z.string().max(100).optional(),
	isModificationEnabled: z.boolean().optional(),
	isUploadEnabled: z.boolean().optional(),
	sortOrder: SafeNonNegativeIntegerSchema.optional(),
}).refine((value) => value.isModificationEnabled === undefined || value.isUploadEnabled === undefined
	|| value.isModificationEnabled === value.isUploadEnabled, { message: 'Modification flags disagree', path: ['isModificationEnabled'] });
export type UpdateExhibitionBaseSchemaInput = z.input<typeof UpdateExhibitionBaseSchema>;
export type UpdateExhibitionRequest = z.input<typeof UpdateExhibitionBaseSchema>;

export const AddMemberSchema = z.object({
	name: z.string().min(1).max(50),
	studentId: z.string().min(1).max(20),
	sortOrder: SafeNonNegativeIntegerSchema.optional(),
});
export type AddMemberSchemaInput = z.input<typeof AddMemberSchema>;
export type AddMemberRequest = z.input<typeof AddMemberSchema>;

export const UpdateMemberBaseSchema = z.object({
	name: z.string().min(1).max(50).optional(),
	studentId: z.string().min(1).max(20).optional(),
	sortOrder: SafeNonNegativeIntegerSchema.optional(),
});
export type UpdateMemberBaseSchemaInput = z.input<typeof UpdateMemberBaseSchema>;
export type UpdateMemberRequest = z.input<typeof UpdateMemberBaseSchema>;

export const SwapProjectMembersSchema = z.object({
	memberIdA: SafePositiveIntegerSchema,
	memberIdB: SafePositiveIntegerSchema,
});
export type SwapProjectMembersSchemaInput = z.input<typeof SwapProjectMembersSchema>;
export type SwapProjectMembersRequest = z.input<typeof SwapProjectMembersSchema>;

export const GoogleAuthRequestSchema = z.object({
	credential: z.string().min(1),
});
export type GoogleAuthRequestSchemaInput = z.input<typeof GoogleAuthRequestSchema>;
export type GoogleAuthRequest = z.input<typeof GoogleAuthRequestSchema>;

export const DevAuthLoginRequestSchema = z.object({
	role: UserRoleSchema,
});
export type DevAuthLoginRequestSchemaInput = z.input<typeof DevAuthLoginRequestSchema>;
export type DevAuthLoginRequest = z.input<typeof DevAuthLoginRequestSchema>;

export const DevAuthLoginErrorRequestSchema = z.object({
	scenario: DevAuthErrorScenarioSchema,
});
export type DevAuthLoginErrorRequestSchemaInput = z.input<typeof DevAuthLoginErrorRequestSchema>;
export type DevAuthLoginErrorRequest = z.input<typeof DevAuthLoginErrorRequestSchema>;

export const SetProjectVideoOrderSchema = z.object({
	expectedOrder: z.array(z.number().int().positive()),
	order: z.array(z.number().int().positive()),
}).strict();
export type SetProjectVideoOrderRequest = z.input<typeof SetProjectVideoOrderSchema>;
export type ProjectSubmissionManifestItem = SubmitProjectPayloadOutput['manifest'][number];
