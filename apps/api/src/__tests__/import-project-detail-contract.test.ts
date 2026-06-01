import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminProjectDetail, PublicProjectDetailResponse } from '@pcu/contracts';

const mocks = vi.hoisted(() => ({
	runTransaction: vi.fn(),
	findExhibitionByComposite: vi.fn(),
	upsertExhibition: vi.fn(),
	findProjectBySlug: vi.fn(),
	createProjectWithMembers: vi.fn(),
	findExhibitionsWithPublishedCounts: vi.fn(),
	findExhibitionsByYear: vi.fn(),
	findPublishedProjectsInExhibitions: vi.fn(),
	findPublishedProjectById: vi.fn(),
	findPublishedProjectBySlug: vi.fn(),
	findExhibitionPosterByStorageKey: vi.fn(),
	getPresignedUrl: vi.fn(),
}));

vi.mock('../config/env.js', () => ({
	env: () => ({
		API_PUBLIC_URL: 'https://api.example.com',
		S3_BUCKET_PUBLIC: 'pcu-public',
		S3_PRESIGN_TTL_SEC: 60,
		LOG_LEVEL: 'silent',
		NODE_ENV: 'test',
	}),
	loadEnv: () => ({
		API_PUBLIC_URL: 'https://api.example.com',
		S3_BUCKET_PUBLIC: 'pcu-public',
		S3_PRESIGN_TTL_SEC: 60,
		LOG_LEVEL: 'silent',
		NODE_ENV: 'test',
	}),
}));

vi.mock('../modules/admin/import/repository.js', () => ({
	runTransaction: mocks.runTransaction,
	findExhibitionByComposite: mocks.findExhibitionByComposite,
	upsertExhibition: mocks.upsertExhibition,
	findProjectBySlug: mocks.findProjectBySlug,
	createProjectWithMembers: mocks.createProjectWithMembers,
}));

vi.mock('../modules/public/repository.js', () => ({
	findExhibitionsWithPublishedCounts: mocks.findExhibitionsWithPublishedCounts,
	findExhibitionsByYear: mocks.findExhibitionsByYear,
	findPublishedProjectsInExhibitions: mocks.findPublishedProjectsInExhibitions,
	findPublishedProjectById: mocks.findPublishedProjectById,
	findPublishedProjectBySlug: mocks.findPublishedProjectBySlug,
	findExhibitionPosterByStorageKey: mocks.findExhibitionPosterByStorageKey,
}));

vi.mock('../lib/storage.js', () => ({
	getPresignedUrl: mocks.getPresignedUrl,
}));

import { executeImport } from '../modules/admin/import/service.js';
import { serializeProjectDetail } from '../modules/admin/project/serializer.js';
import { getProjectDetail } from '../modules/public/service.js';

describe('imported project detail contract fields', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.runTransaction.mockImplementation(async (fn) => fn({}));
		mocks.findExhibitionByComposite.mockResolvedValue(null);
		mocks.upsertExhibition.mockResolvedValue({ id: 77, year: 2026, title: '2026 Show' });
		mocks.findProjectBySlug.mockResolvedValue(null);
	});

	it('roundtrips githubUrl and platforms from import into admin and public detail responses', async () => {
		const githubUrl = 'https://github.com/pcu/example-game';
		const platforms = ['PC', 'WEB'] as const;
		let createdProject: {
			exhibitionId: number;
			slug: string;
			title: string;
			summary: string;
			description: string;
			isIncomplete: boolean;
			status: 'PUBLISHED' | 'ARCHIVED';
			githubUrl: string;
			platforms: ('PC' | 'MOBILE' | 'WEB')[];
			creatorId: number;
			members: { name: string; studentId: string; sortOrder: number }[];
		} | undefined;

		mocks.createProjectWithMembers.mockImplementation(async (_tx, data) => {
			createdProject = data;
			return { id: 101, ...data };
		});

		await expect(executeImport(JSON.stringify({
			years: [{ year: 2026, title: '2026 Show' }],
			projects: [{
				year: 2026,
				title: 'Contract Drift Game',
				slug: 'contract-drift-game',
				summary: 'Imported with repository metadata',
				description: 'Imported fields must remain visible in detail APIs.',
				githubUrl,
				platforms: [...platforms],
				members: [{ name: 'Student One', studentId: '20260001' }],
			}],
		}), 9)).resolves.toEqual({
			exhibitions: { created: 1, existing: 0 },
			projects: { created: 1 },
		});

		expect(createdProject).toMatchObject({
			githubUrl,
			platforms: [...platforms],
		});

		const detailRecord = {
			id: 101,
			title: createdProject!.title,
			slug: createdProject!.slug,
			exhibition: { year: 2026 },
			summary: createdProject!.summary,
			description: createdProject!.description,
			isIncomplete: createdProject!.isIncomplete,
			status: createdProject!.status,
			sortOrder: 0,
			githubUrl: createdProject!.githubUrl,
			platforms: createdProject!.platforms,
			posterAssetId: null,
			poster: null,
			members: createdProject!.members.map((member, index) => ({
				id: index + 1,
				name: member.name,
				studentId: member.studentId,
				sortOrder: member.sortOrder,
				userId: null,
			})),
			assets: [],
		};

		const adminDetail: AdminProjectDetail = serializeProjectDetail(detailRecord);
		expect(adminDetail).toMatchObject({
			githubUrl,
			platforms: [...platforms],
		});

		mocks.findPublishedProjectById.mockResolvedValue(detailRecord);
		const publicDetail: PublicProjectDetailResponse = await getProjectDetail('101');
		expect(publicDetail).toMatchObject({
			githubUrl,
			platforms: [...platforms],
		});
	});
});
