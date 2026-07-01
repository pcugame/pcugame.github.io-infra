import { z } from 'zod';

export const ProjectStatusSchema = z.enum(['PUBLISHED', 'ARCHIVED']);
export const AssetKindSchema = z.enum(['THUMBNAIL', 'IMAGE', 'POSTER', 'GAME', 'VIDEO']);

export const ProjectMemberInputSchema = z.object({
	name: z.string().min(1).max(50),
	studentId: z.string().min(1).max(20),
	sortOrder: z.number().int().min(0).optional(),
	userId: z.number().int().positive().optional(),
});

export const SubmitProjectPayloadBaseSchema = z.object({
	exhibitionId: z.number().int().positive(),
	title: z.string().min(1).max(120),
	summary: z.string().max(300).optional(),
	description: z.string().max(5000).optional(),
	members: z.array(ProjectMemberInputSchema).min(1),
});

export const UpdateProjectBaseSchema = z.object({
	title: z.string().min(1).max(120).optional(),
	summary: z.string().max(300).optional(),
	description: z.string().max(5000).optional(),
	isIncomplete: z.boolean().optional(),
	status: ProjectStatusSchema.optional(),
	sortOrder: z.number().int().min(0).optional(),
});

export const CreateExhibitionBaseSchema = z.object({
	year: z.number().int().min(2021).max(2100),
	title: z.string().max(100).optional(),
	isUploadEnabled: z.boolean().optional(),
	sortOrder: z.number().int().min(0).optional(),
});

export const UpdateExhibitionBaseSchema = z.object({
	title: z.string().max(100).optional(),
	isUploadEnabled: z.boolean().optional(),
	sortOrder: z.number().int().min(0).optional(),
});

export const AddMemberSchema = z.object({
	name: z.string().min(1).max(50),
	studentId: z.string().min(1).max(20),
	sortOrder: z.number().int().min(0).optional(),
});

export const UpdateMemberBaseSchema = z.object({
	name: z.string().min(1).max(50).optional(),
	studentId: z.string().min(1).max(20).optional(),
	sortOrder: z.number().int().min(0).optional(),
});

export type ProjectMemberInputSchemaInput = z.infer<typeof ProjectMemberInputSchema>;
export type SubmitProjectPayloadBaseSchemaInput = z.infer<typeof SubmitProjectPayloadBaseSchema>;
export type UpdateProjectBaseSchemaInput = z.infer<typeof UpdateProjectBaseSchema>;
export type CreateExhibitionBaseSchemaInput = z.infer<typeof CreateExhibitionBaseSchema>;
export type UpdateExhibitionBaseSchemaInput = z.infer<typeof UpdateExhibitionBaseSchema>;
export type AddMemberSchemaInput = z.infer<typeof AddMemberSchema>;
export type UpdateMemberBaseSchemaInput = z.infer<typeof UpdateMemberBaseSchema>;
