import { describe, expect, it } from 'vitest';
import { CreateExhibitionBaseSchema, UpdateExhibitionBaseSchema } from './schemas.js';
import { CreateProjectChangeSchema, UpdateProjectChangeSchema, ProjectChangeDetailSchema } from './project-change-schemas.js';

describe('year policy compatibility', () => {
	it.each([CreateExhibitionBaseSchema, UpdateExhibitionBaseSchema])('accepts either name but rejects contradictory policy', (schema) => {
		for (const flag of [{ isModificationEnabled: false }, { isUploadEnabled: false }, { isModificationEnabled: false, isUploadEnabled: false }]) {
			expect(schema.safeParse({ year: 2026, ...flag }).success).toBe(true);
		}
		expect(schema.safeParse({ year: 2026, isModificationEnabled: true, isUploadEnabled: false }).success).toBe(false);
	});
});

describe('change request boundary', () => {
	it.each(['GAME', 'WEBGL', 'POSTER', 'IMAGE', 'VIDEO', 'DOCUMENT', 'ATTACHMENT'])('checks the canonical %s upload slot at the boundary', (kind) => {
		const slot = ['GAME', 'WEBGL', 'POSTER'].includes(kind) ? kind.toLowerCase() : `${kind.toLowerCase()}:0`;
		const item = { kind, slot, clientToken: 'a'.repeat(32) };
		expect(UpdateProjectChangeSchema.safeParse({ manifest: [item] }).success).toBe(true);
		expect(UpdateProjectChangeSchema.safeParse({ manifest: [{ ...item, slot: `${kind.toLowerCase()}-0` }] }).success).toBe(false);
	});
	it('requires a nonempty request reason', () => {
		expect(CreateProjectChangeSchema.safeParse({ kind: 'DELETE', reason: '  ' }).success).toBe(false);
	});
	it('rejects privileged fields, forged team user IDs and unsafe links', () => {
		for (const changes of [{ status: 'PUBLISHED' }, { creatorId: 1 }, { members: [{ name: 'Team', studentId: '123', userId: 1 }] }, { githubUrl: 'javascript:alert(1)' }]) {
			expect(UpdateProjectChangeSchema.safeParse({ changes }).success).toBe(false);
		}
	});
	it('preserves explicit removals and empty collections in serialized detail', () => {
		const detail = {
			id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', projectId: null, originalProjectId: 1, projectTitle: 'Game',
			actorId: 1, kind: 'EDIT', state: 'COMPLETED', reason: 'Update', reviewReason: null, reviewerId: 2, error: null,
			baseVersion: 1, createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z', submittedAt: null, reviewedAt: null, completedAt: null,
			before: { assets: [], currentWebglDeploymentId: null }, changes: { members: [], removeAssetIds: [3], posterAssetId: null, removeWebgl: true },
			stagingProjectId: null, submissionId: null, items: [], stagedAssets: [],
		};
		expect(ProjectChangeDetailSchema.parse(detail)).toEqual(detail);
	});
});
