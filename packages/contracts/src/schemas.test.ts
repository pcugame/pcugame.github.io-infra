import { describe, expect, it } from 'vitest';
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
	ProjectMemberInputSchema,
	ProjectStatusSchema,
	SetProjectPosterSchema,
	SortOrderSchema,
	SubmitProjectPayloadBaseSchema,
	UpdateExhibitionBaseSchema,
	UpdateMemberBaseSchema,
	UpdateProjectBaseSchema,
	UserRoleSchema,
} from './schemas.js';

describe('shared enum schemas', () => {
	it('accepts only public project statuses', () => {
		expect(ProjectStatusSchema.safeParse('PUBLISHED').success).toBe(true);
		expect(ProjectStatusSchema.safeParse('ARCHIVED').success).toBe(true);
		expect(ProjectStatusSchema.safeParse('DRAFT').success).toBe(false);
	});

	it('keeps asset kinds and roles constrained', () => {
		expect(AssetKindSchema.safeParse('VIDEO').success).toBe(true);
		expect(AssetKindSchema.safeParse('AUDIO').success).toBe(false);
		expect(UserRoleSchema.safeParse('ADMIN').success).toBe(true);
		expect(UserRoleSchema.safeParse('ROOT').success).toBe(false);
	});

	it('accepts only supported sort orders', () => {
		expect(SortOrderSchema.safeParse('asc').success).toBe(true);
		expect(SortOrderSchema.safeParse('sideways').success).toBe(false);
	});
});

describe('project payload schemas', () => {
	const member = { name: 'Student', studentId: '20260001' };

	it('accepts a minimal project submission payload', () => {
		expect(SubmitProjectPayloadBaseSchema.parse({
			exhibitionId: 1,
			title: 'Project',
			members: [member],
		})).toEqual({
			exhibitionId: 1,
			title: 'Project',
			members: [member],
		});
	});

	it('limits new project titles to 125 UTF-8 bytes', () => {
		expect(SubmitProjectPayloadBaseSchema.safeParse({
			exhibitionId: 1,
			title: 'a'.repeat(125),
			members: [member],
		}).success).toBe(true);
		expect(SubmitProjectPayloadBaseSchema.safeParse({
			exhibitionId: 1,
			title: 'a'.repeat(126),
			members: [member],
		}).success).toBe(false);
		expect(SubmitProjectPayloadBaseSchema.safeParse({
			exhibitionId: 1,
			title: '가'.repeat(41),
			members: [member],
		}).success).toBe(true);
		expect(SubmitProjectPayloadBaseSchema.safeParse({
			exhibitionId: 1,
			title: '가'.repeat(42),
			members: [member],
		}).success).toBe(false);
	});

	it('rejects missing members and invalid member linking', () => {
		expect(SubmitProjectPayloadBaseSchema.safeParse({
			exhibitionId: 1,
			title: 'Project',
			members: [],
		}).success).toBe(false);
		expect(ProjectMemberInputSchema.safeParse({
			...member,
			userId: 0,
		}).success).toBe(false);
	});

	it('allows partial project updates but rejects empty titles', () => {
		expect(UpdateProjectBaseSchema.safeParse({}).success).toBe(true);
		expect(UpdateProjectBaseSchema.safeParse({ status: 'ARCHIVED' }).success).toBe(true);
		expect(UpdateProjectBaseSchema.safeParse({ title: '' }).success).toBe(false);
	});

	it('validates list query, bulk actions, poster, and member operations', () => {
		expect(AdminProjectListQueryBaseSchema.safeParse({
			page: 1,
			limit: 100,
			sort: 'title',
			order: 'asc',
		}).success).toBe(true);
		expect(AdminProjectListQueryBaseSchema.safeParse({ sort: 'updatedAt' }).success).toBe(false);
		expect(BulkUpdateProjectStatusSchema.safeParse({ ids: [1, 2], status: 'PUBLISHED' }).success).toBe(true);
		expect(BulkDeleteProjectsSchema.safeParse({ ids: [] }).success).toBe(false);
		expect(SetProjectPosterSchema.safeParse({ assetId: 1 }).success).toBe(true);
		expect(AddMemberSchema.safeParse(member).success).toBe(true);
		expect(UpdateMemberBaseSchema.safeParse({ name: 'Updated' }).success).toBe(true);
	});
});

describe('exhibition and auth schemas', () => {
	it('validates exhibition create and update payloads', () => {
		expect(CreateExhibitionBaseSchema.safeParse({ year: 2026 }).success).toBe(true);
		expect(CreateExhibitionBaseSchema.safeParse({ year: 2020 }).success).toBe(false);
		expect(UpdateExhibitionBaseSchema.safeParse({ isUploadEnabled: false }).success).toBe(true);
		expect(UpdateExhibitionBaseSchema.safeParse({ sortOrder: -1 }).success).toBe(false);
	});

	it('validates auth and game upload payloads', () => {
		expect(GoogleAuthRequestSchema.safeParse({ credential: 'token' }).success).toBe(true);
		expect(GoogleAuthRequestSchema.safeParse({ credential: '' }).success).toBe(false);
		expect(DevAuthLoginRequestSchema.safeParse({ role: 'OPERATOR' }).success).toBe(true);
		expect(DevAuthLoginErrorRequestSchema.safeParse({ scenario: 'domain-not-allowed' }).success).toBe(true);
		expect(GameUploadCreateSessionSchema.safeParse({ originalName: 'game.zip', totalBytes: 1 }).success).toBe(true);
		expect(GameUploadCreateSessionSchema.safeParse({ originalName: '', totalBytes: 0 }).success).toBe(false);
	});
});
