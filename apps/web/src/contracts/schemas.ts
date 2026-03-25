// ── Zod 스키마 (프론트 폼 validation + 향후 contracts 공유용) ─

import { z } from 'zod';

// ── 멤버 입력 ────────────────────────────────────────────────

export const ProjectMemberInputSchema = z.object({
  name: z.string().min(1, '이름을 입력하세요').max(50),
  studentId: z.string().min(1, '학번을 입력하세요').max(20),
  sortOrder: z.number().int().nonnegative().optional(),
});

export type ProjectMemberInput = z.infer<typeof ProjectMemberInputSchema>;

// ── 작품 등록 (submit all-in-one) ────────────────────────────

export const SubmitProjectPayloadSchema = z.object({
  year: z.number().int().min(2021, '2021 이상').max(2100),
  title: z.string().min(1, '제목을 입력하세요').max(120),
  summary: z.string().max(300).optional().or(z.literal('')),
  description: z.string().max(5000).optional().or(z.literal('')),
  youtubeUrl: z
    .string()
    .url('올바른 URL을 입력하세요')
    .optional()
    .or(z.literal('')),
  autoPublish: z.boolean().optional(),
  members: z
    .array(ProjectMemberInputSchema)
    .min(1, '최소 1명의 참여 학생을 추가하세요'),
});

export type SubmitProjectPayloadInput = z.infer<typeof SubmitProjectPayloadSchema>;

// ── 작품 수정 ────────────────────────────────────────────────

export const UpdateProjectFormSchema = z.object({
  title: z.string().min(1, '제목을 입력하세요').max(120),
  summary: z.string().max(300).optional().or(z.literal('')),
  description: z.string().max(5000).optional().or(z.literal('')),
  youtubeUrl: z
    .string()
    .url('올바른 URL을 입력하세요')
    .optional()
    .or(z.literal('')),
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional(),
  sortOrder: z.number().int().nonnegative().optional(),
  downloadPolicy: z.enum(['NONE', 'PUBLIC', 'SCHOOL_ONLY', 'ADMIN_ONLY']).optional(),
});

export type UpdateProjectFormInput = z.infer<typeof UpdateProjectFormSchema>;

// ── 연도 생성/수정 ──────────────────────────────────────────

export const CreateYearSchema = z.object({
  year: z.number().int().min(2021).max(2100),
  title: z.string().max(100).optional().or(z.literal('')),
  isOpen: z.boolean().optional(),
  sortOrder: z.number().int().nonnegative().optional(),
});

export type CreateYearInput = z.infer<typeof CreateYearSchema>;

export const UpdateYearSchema = z.object({
  title: z.string().max(100).optional().or(z.literal('')),
  isOpen: z.boolean().optional(),
  sortOrder: z.number().int().nonnegative().optional(),
});

export type UpdateYearInput = z.infer<typeof UpdateYearSchema>;

// ── 멤버 추가/수정 (admin edit 화면용) ───────────────────────

export const AddMemberSchema = z.object({
  name: z.string().min(1, '이름을 입력하세요').max(50),
  studentId: z.string().min(1, '학번을 입력하세요').max(20),
  sortOrder: z.number().int().nonnegative().optional(),
});

export type AddMemberInput = z.infer<typeof AddMemberSchema>;
