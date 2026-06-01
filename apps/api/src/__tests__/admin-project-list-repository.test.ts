import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	projectCount: vi.fn(),
	projectFindMany: vi.fn(),
	transaction: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
	prisma: {
		project: {
			count: mocks.projectCount,
			findMany: mocks.projectFindMany,
		},
		$transaction: mocks.transaction,
	},
}));

import { findProjectsForUser, type FindProjectsForUserOptions } from '../modules/admin/project/repository.js';

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
		await findProjectsForUser(303, true, {
			...defaultOptions,
			page: 2,
			limit: 10,
		});

		expect(mocks.projectCount).toHaveBeenCalledWith({ where: {} });
		expect(mocks.projectFindMany).toHaveBeenCalledWith(expect.objectContaining({
			where: {},
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
		await findProjectsForUser(101, false, defaultOptions);

		expect(mocks.projectCount).toHaveBeenCalledWith({
			where: {
				AND: [
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

	it('adds title, summary, member name, and student id search filters', async () => {
		await findProjectsForUser(303, true, {
			...defaultOptions,
			search: 'alpha',
		});

		expect(mocks.projectFindMany).toHaveBeenCalledWith(expect.objectContaining({
			where: {
				AND: [
					{
						OR: [
							{ title: { contains: 'alpha', mode: 'insensitive' } },
							{ summary: { contains: 'alpha', mode: 'insensitive' } },
							{ members: { some: { name: { contains: 'alpha', mode: 'insensitive' } } } },
							{ members: { some: { studentId: { contains: 'alpha', mode: 'insensitive' } } } },
						],
					},
				],
			},
		}));
	});

	it('adds status and year filters', async () => {
		await findProjectsForUser(303, true, {
			...defaultOptions,
			status: 'ARCHIVED',
			year: 2026,
		});

		expect(mocks.projectFindMany).toHaveBeenCalledWith(expect.objectContaining({
			where: {
				AND: [
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
		await findProjectsForUser(303, true, {
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

		const result = await findProjectsForUser(303, true, defaultOptions);

		expect(result).toEqual({ totalItems: 2, items });
	});
});
