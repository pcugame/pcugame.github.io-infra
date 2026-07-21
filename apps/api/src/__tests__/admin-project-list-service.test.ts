import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectService } from '../modules/admin/project/service.js';

const mocks = {
	findProjectsForUser: vi.fn(),
};

const projectService = createProjectService({
	repository: {
		findProjectsForUser: mocks.findProjectsForUser,
		findProjectById: vi.fn(),
		isMemberOfProject: vi.fn(),
		updateProject: vi.fn(),
		deleteProjectReturningAssets: vi.fn(),
		clearWebglDeployment: vi.fn(),
		findAssetById: vi.fn(),
		setProjectPoster: vi.fn(),
		bulkDeleteProjectsReturningAssets: vi.fn(),
	},
	serializeProjectDetail: vi.fn(),
	deleteAssetObjects: vi.fn(),
	abortMultipart: vi.fn(),
	cleanupWebglEntry: vi.fn(),
	cleanupWebglDeployment: vi.fn(),
	logger: { error: vi.fn() },
});

function fakeProject(overrides: Record<string, unknown> = {}) {
	return {
		id: 1,
		title: 'Alpha Project',
		slug: 'alpha-project',
		exhibition: { year: 2026 },
		isIncomplete: false,
		status: 'PUBLISHED' as const,
		creator: { name: 'Admin Writer' },
		members: [
			{ name: 'Kim Student', studentId: '20260001' },
		],
		assets: [] as { kind: 'GAME' | 'VIDEO' }[],
		poster: null,
		updatedAt: new Date('2026-05-01T00:00:00.000Z'),
		...overrides,
	};
}

describe('admin project list service', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findProjectsForUser.mockResolvedValue({
			totalItems: 45,
			items: [fakeProject()],
		});
	});

	it.each([
		['ADMIN', true],
		['OPERATOR', true],
		['USER', false],
	] as const)('passes privileged=%s scope to repository', async (role, isPrivileged) => {
		await projectService.listProjects(7, role, {
			page: 1,
			limit: 20,
			sort: 'createdAt',
			order: 'desc',
		});

		expect(mocks.findProjectsForUser).toHaveBeenCalledWith(7, isPrivileged, expect.objectContaining({
			page: 1,
			limit: 20,
		}));
	});

	it('serializes items and returns accurate pagination metadata', async () => {
		const result = await projectService.listProjects(7, 'ADMIN', {
			page: 2,
			limit: 20,
			sort: 'createdAt',
			order: 'desc',
		});

		expect(result.items).toEqual([
			{
				id: 1,
				title: 'Alpha Project',
				slug: 'alpha-project',
				year: 2026,
				isIncomplete: false,
				status: 'PUBLISHED',
				createdByUserName: 'Admin Writer',
				memberNames: ['Kim Student'],
				memberStudentIds: ['20260001'],
				updatedAt: '2026-05-01T00:00:00.000Z',
			},
		]);
		expect(result.pagination).toEqual({
			page: 2,
			limit: 20,
			totalItems: 45,
			totalPages: 3,
			hasNextPage: true,
			hasPreviousPage: true,
		});
	});

	it('marks the last page correctly', async () => {
		const result = await projectService.listProjects(7, 'ADMIN', {
			page: 3,
			limit: 20,
			sort: 'createdAt',
			order: 'desc',
		});

		expect(result.pagination).toMatchObject({
			totalItems: 45,
			totalPages: 3,
			hasNextPage: false,
			hasPreviousPage: true,
		});
	});
});
