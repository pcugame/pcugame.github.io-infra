import { z } from 'zod';
import { SubmitProjectResponseSchema } from './response-schemas.js';

const Id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Time = z.string().datetime();
export const ProjectChangeStateSchema = z.enum(['DRAFT', 'PENDING', 'APPLYING', 'COMPLETED', 'REJECTED', 'CANCELLED', 'CONFLICT', 'FAILED']);
export const ProjectChangeValuesSchema = z.object({
	title: z.string().trim().min(1).max(120).optional(),
	summary: z.string().max(300).optional(),
	description: z.string().max(5000).optional(),
	githubUrl: z.union([z.literal(''), z.url({ protocol: /^https?$/ })]).optional(),
	platforms: z.array(z.enum(['PC', 'MOBILE', 'WEB'])).max(3).optional(),
	members: z.array(z.object({ name: z.string().trim().min(1).max(50), studentId: z.string().max(20) }).strict()).max(100).optional(),
	removeAssetIds: z.array(Id).max(500).optional(),
	posterAssetId: Id.nullable().optional(),
	videoAssetIds: z.array(Id).max(5).optional(),
	removeWebgl: z.boolean().optional(),
}).strict();
export const CreateProjectChangeSchema = z.object({
	kind: z.enum(['EDIT', 'DELETE']), reason: z.string().trim().min(1).max(2000),
}).strict();
export const UpdateProjectChangeSchema = z.object({
	reason: z.string().trim().min(1).max(2000).optional(),
	changes: ProjectChangeValuesSchema.optional(),
	manifest: z.array(z.object({
		kind: z.enum(['GAME', 'WEBGL', 'VIDEO', 'IMAGE', 'POSTER', 'DOCUMENT', 'ATTACHMENT']),
		slot: z.string().min(1).max(100), clientToken: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
	}).strict().refine((item) => ['GAME', 'WEBGL', 'POSTER'].includes(item.kind)
		? item.slot === item.kind.toLowerCase()
		: new RegExp(`^${item.kind.toLowerCase()}:(0|[1-9][0-9]*)$`).test(item.slot), { message: 'Upload slot does not match its kind', path: ['slot'] })).max(100).optional(),
}).strict();
export const RejectProjectChangeSchema = z.object({ reason: z.string().trim().min(1).max(2000) }).strict();
export const ProjectChangeSummarySchema = z.object({
	id: z.string().uuid(), projectId: Id.nullable(), originalProjectId: Id, projectTitle: z.string(),
	actorId: Id, kind: z.enum(['EDIT', 'DELETE']), state: ProjectChangeStateSchema,
	reason: z.string(), reviewReason: z.string().nullable(), reviewerId: Id.nullable(), error: z.string().nullable(),
	baseVersion: Id, createdAt: Time, updatedAt: Time, submittedAt: Time.nullable(), reviewedAt: Time.nullable(), completedAt: Time.nullable(),
}).strict();
export const ProjectChangeDetailSchema = ProjectChangeSummarySchema.extend({
	before: ProjectChangeValuesSchema.extend({
		title: z.string().optional(), summary: z.string().optional(), description: z.string().optional(), githubUrl: z.string().optional(),
		members: z.array(z.object({ name: z.string(), studentId: z.string() }).strict()).optional(),
		assets: z.array(z.object({ id: Id, kind: z.string(), originalName: z.string() }).strict()),
		currentWebglDeploymentId: z.string().nullable(),
	}),
	changes: ProjectChangeValuesSchema,
	stagingProjectId: Id.nullable(), submissionId: z.string().uuid().nullable(), items: SubmitProjectResponseSchema.shape.items,
	stagedAssets: z.array(z.object({ id: Id, kind: z.string(), originalName: z.string(), previewUrl: z.string() }).strict()),
}).strict();
export const ProjectChangeListResponseSchema = z.object({ items: z.array(ProjectChangeSummarySchema), total: z.number().int().nonnegative() }).strict();
