// ── Web form Zod wrappers around shared transport schemas ─

import { z } from 'zod';
import {
	AddMemberSchema as SharedAddMemberSchema,
	CreateExhibitionBaseSchema,
	ProjectMemberInputSchema as SharedProjectMemberInputSchema,
	ProjectStatusSchema,
	SubmitProjectPayloadBaseSchema,
	UpdateExhibitionBaseSchema,
	UpdateProjectBaseSchema,
} from '@pcu/contracts';

// ── 멤버 입력 ────────────────────────────────────────────────

export const ProjectMemberInputSchema = SharedProjectMemberInputSchema.extend({
  name: z.string().min(1, '이름을 입력하세요').max(50),
  studentId: z.string().min(1, '학번을 입력하세요').max(20),
});

export type ProjectMemberInput = z.infer<typeof ProjectMemberInputSchema>;

// ── 작품 등록 (submit all-in-one) ────────────────────────────

export const SubmitProjectPayloadSchema = SubmitProjectPayloadBaseSchema.extend({
  exhibitionId: z.number().int().positive('전시회를 선택하세요'),
  title: z.string().min(1, '제목을 입력하세요').max(120),
  summary: z.string().max(300).optional().or(z.literal('')),
  description: z.string().max(5000).optional().or(z.literal('')),
  members: z
    .array(ProjectMemberInputSchema)
    .min(1, '최소 1명의 참여 학생을 추가하세요'),
});

export type SubmitProjectPayloadInput = z.infer<typeof SubmitProjectPayloadSchema>;

// ── 작품 수정 ────────────────────────────────────────────────

export const UpdateProjectFormSchema = UpdateProjectBaseSchema.pick({
	title: true,
	summary: true,
	description: true,
	status: true,
	sortOrder: true,
}).extend({
  title: z.string().min(1, '제목을 입력하세요').max(120),
  summary: z.string().max(300).optional().or(z.literal('')),
  description: z.string().max(5000).optional().or(z.literal('')),
  status: ProjectStatusSchema.optional(),
});

export type UpdateProjectFormInput = z.infer<typeof UpdateProjectFormSchema>;

// ── 전시회 생성/수정 ────────────────────────────────────────

export const CreateExhibitionSchema = CreateExhibitionBaseSchema.extend({
  year: z.number().int().min(2021).max(2100),
  title: z.string().max(100).optional().or(z.literal('')),
});

export type CreateExhibitionInput = z.infer<typeof CreateExhibitionSchema>;

export const UpdateExhibitionSchema = UpdateExhibitionBaseSchema.extend({
  title: z.string().max(100).optional().or(z.literal('')),
});

export type UpdateExhibitionInput = z.infer<typeof UpdateExhibitionSchema>;

// ── 멤버 추가/수정 (admin edit 화면용) ───────────────────────

export const AddMemberSchema = SharedAddMemberSchema.extend({
  name: z.string().min(1, '이름을 입력하세요').max(50),
  studentId: z.string().min(1, '학번을 입력하세요').max(20),
});

export type AddMemberInput = z.infer<typeof AddMemberSchema>;
