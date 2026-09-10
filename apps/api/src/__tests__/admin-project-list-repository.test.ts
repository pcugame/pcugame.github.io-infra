import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';

const mocks = vi.hoisted(() => ({
	projectCount: vi.fn(),
	projectFindMany: vi.fn(),
	transaction: vi.fn(),
}));

import {
	createProjectCrudRepository,
	type FindProjectsForUserOptions,
} from '../modules/admin/project/crud.repository.js';

const repository = createProjectCrudRepository({
	project: {
		count: mocks.projectCount,
		findMany: mocks.projectFindMany,
	},
	$transaction: mocks.transaction,
} as unknown as PrismaClient);

const defaultOptions: FindProjectsForUserOptions = {
	page: 1,
	limit: 20,
	sort: 'createdAt',
	order: 'desc',
};

describe('admin project list repository', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.projectCount.mockReturnValue({ query: 'count' });
		mocks.projectFindMany.mockReturnValue({ query: 'findMany' });
		mocks.transaction.mockResolvedValue([0, []]);
	});

	it('builds explicit pagination queries for privileged users', async () => {
		await repository.findProjectsForUser(303, true, {
			...defaultOptions,
			page: 2,
			limit: 10,
		});

		expect(mocks.projectCount).toHaveBeenCalledWith({ where: { AND: [{ changeRequestDraft: null }] } });
		expect(mocks.projectFindMany).toHaveBeenCalledWith(expect.objectContaining({
			where: { AND: [{ changeRequestDraft: null }] },
			orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
			skip: 10,
			take: 10,
			include: expect.any(Object),
		}));
		expect(mocks.transaction).toHaveBeenCalledWith([
			{ query: 'count' },
			{ query: 'findMany' },
		]);
	});

	it('scopes USER queries to creator or linked member projects', async () => {
		await repository.findProjectsForUser(101, false, defaultOptions);

		expect(mocks.projectCount).toHaveBeenCalledWith({
			where: {
				AND: [
					{ changeRequestDraft: null },
					{
						OR: [
							{ creatorId: 101 },
							{ members: { some: { userId: 101 } } },
						],
					},
				],
			},
		});
	});

	it('adds title, summary, member, and exhibition title search filters', async () => {
		await repository.findProjectsForUser(303, true, {
			...defaultOptions,
			search: 'alpha',
		});

		expect(mocks.projectFindMany).toHaveBeenCalledWith(expect.objectContaining({
			where: {
				AND: [
					{ changeRequestDraft: null },
					{
						OR: [
							{ title: { contains: 'alpha', mode: 'insensitive' } },
							{ summary: { contains: 'alpha', mode: 'insensitive' } },
							{ members: { some: { name: { contains: 'alpha', mode: 'insensitive' } } } },
							{ members: { some: { studentId: { contains: 'alpha', mode: 'insensitive' } } } },
							{ exhibition: { title: { contains: 'alpha', mode: 'insensitive' } } },
						],
					},
				],
			},
		}));
	});

	it('ANDs distinct whitespace-delimited search tokens while ORing each token fields', async () => {
		await repository.findProjectsForUser(303, true, {
			...defaultOptions,
			search: '  2026  Graduation\t2026  ',
		});

		expect(mocks.projectFindMany).toHaveBeenCalledWith(expect.objectContaining({
			where: {
				AND: [
					{ changeRequestDraft: null },
					{
						OR: [
							{ title: { contains: '2026', mode: 'insensitive' } },
							{ summary: { contains: '2026', mode: 'insensitive' } },
							{ members: { some: { name: { contains: '2026', mode: 'insensitive' } } } },
							{ members: { some: { studentId: { contains: '2026', mode: 'insensitive' } } } },
							{ exhibition: { title: { contains: '2026', mode: 'insensitive' } } },
							{ exhibition: { year: 2026 } },
						],
					},
					{
						OR: [
							{ title: { contains: 'Graduation', mode: 'insensitive' } },
							{ summary: { contains: 'Graduation', mode: 'insensitive' } },
							{ members: { some: { name: { contains: 'Graduation', mode: 'insensitive' } } } },
							{ members: { some: { studentId: { contains: 'Graduation', mode: 'insensitive' } } } },
							{ exhibition: { title: { contains: 'Graduation', mode: 'insensitive' } } },
						],
					},
				],
			},
		}));
	});

	it('combines an explicit year filter with the search token groups', async () => {
		await repository.findProjectsForUser(303, true, {
			...defaultOptions,
			search: '2026 show',
			year: 2025,
		});

		expect(mocks.projectFindMany).toHaveBeenCalledWith(expect.objectContaining({
			where: expect.objectContaining({
				AND: expect.arrayContaining([
					{ exhibition: { year: 2025 } },
					{ OR: expect.arrayContaining([{ exhibition: { year: 2026 } }]) },
				]),
			}),
		}));
	});

	it('does not treat non-canonical four-character numeric text as an exhibition year', async () => {
		await repository.findProjectsForUser(303, true, {
			...defaultOptions,
			search: '0123',
		});

		expect(mocks.projectFindMany).toHaveBeenCalledWith(expect.objectContaining({
			where: expect.objectContaining({
				AND: expect.arrayContaining([
					{ OR: expect.not.arrayContaining([{ exhibition: { year: 123 } }]) },
				]),
			}),
		}));
	});

	it('adds status and year filters', async () => {
		await repository.findProjectsForUser(303, true, {
			...defaultOptions,
			status: 'ARCHIVED',
			year: 2026,
		});

		expect(mocks.projectFindMany).toHaveBeenCalledWith(expect.objectContaining({
			where: {
				AND: [
					{ changeRequestDraft: null },
					{ exhibition: { year: 2026 } },
					{ status: 'ARCHIVED' },
				],
			},
		}));
	});

	it.each([
		['title', 'asc', [{ title: 'asc' }, { id: 'asc' }]],
		['year', 'desc', [{ exhibition: { year: 'desc' } }, { id: 'desc' }]],
		['status', 'asc', [{ status: 'asc' }, { id: 'asc' }]],
	] as const)('builds whitelisted %s sort order', async (sort, order, orderBy) => {
		await repository.findProjectsForUser(303, true, {
			...defaultOptions,
			sort,
			order,
		});

		expect(mocks.projectFindMany).toHaveBeenCalledWith(expect.objectContaining({
			orderBy,
		}));
	});

	it('returns totalItems with items from the transaction', async () => {
		const items = [{ id: 1 }, { id: 2 }];
		mocks.transaction.mockResolvedValue([2, items]);

		const result = await repository.findProjectsForUser(303, true, defaultOptions);

		expect(result).toEqual({ totalItems: 2, items });
	});
});
