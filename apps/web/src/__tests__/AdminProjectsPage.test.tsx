/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	AdminProjectItem,
	AdminProjectListQuery,
	AdminProjectListResponse,
} from '../contracts';

const mocks = vi.hoisted(() => ({
	getProjects: vi.fn(),
	bulkStatus: vi.fn(),
	bulkDelete: vi.fn(),
	useMe: vi.fn(),
}));

vi.mock('../features/auth', () => ({
	useMe: mocks.useMe,
}));

vi.mock('../lib/useDebouncedValue', () => ({
	useDebouncedValue<T>(value: T) {
		return value;
	},
}));

vi.mock('../lib/api', () => ({
	adminProjectApi: {
		getProjects: mocks.getProjects,
		list: mocks.getProjects,
		bulkStatus: mocks.bulkStatus,
		bulkDelete: mocks.bulkDelete,
	},
	getApiErrorMessage: (error: unknown) =>
		error instanceof Error ? error.message : String(error),
}));

import AdminProjectsPage from '../pages/admin/AdminProjectsPage';

function project(overrides: Partial<AdminProjectItem> = {}): AdminProjectItem {
	return {
		id: 1,
		title: 'Alpha Project',
		slug: 'alpha-project',
		year: 2025,
		isIncomplete: false,
		status: 'PUBLISHED',
		createdByUserName: '관리자',
		memberNames: ['김학생'],
		memberStudentIds: ['2025001'],
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function response(
	items: AdminProjectItem[],
	pagination: Partial<AdminProjectListResponse['pagination']> = {},
): AdminProjectListResponse {
	const totalItems = pagination.totalItems ?? items.length;
	const limit = pagination.limit ?? 20;
	const totalPages = pagination.totalPages ?? (totalItems === 0 ? 0 : Math.ceil(totalItems / limit));

	return {
		items,
		pagination: {
			page: pagination.page ?? 1,
			limit,
			totalItems,
			totalPages,
			hasNextPage: pagination.hasNextPage ?? false,
			hasPreviousPage: pagination.hasPreviousPage ?? false,
		},
	};
}

function renderPage() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});

	return render(
		<QueryClientProvider client={queryClient}>
			<MemoryRouter>
				<AdminProjectsPage />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

async function expectProjectVisible(title: string) {
	await waitFor(() => {
		expect(screen.getAllByText(title).length).toBeGreaterThan(0);
	});
}

function mockPagedProjects() {
	mocks.getProjects.mockImplementation((query: AdminProjectListQuery = {}) => {
		if (query.page === 2) {
			return Promise.resolve(response(
				[
					project({ id: 3, title: 'Gamma Project', slug: 'gamma-project' }),
					project({ id: 4, title: 'Delta Project', slug: 'delta-project' }),
				],
				{
					page: 2,
					totalItems: 4,
					totalPages: 2,
					hasPreviousPage: true,
				},
			));
		}

		return Promise.resolve(response(
			[
				project({ id: 1, title: 'Alpha Project', slug: 'alpha-project' }),
				project({ id: 2, title: 'Beta Project', slug: 'beta-project' }),
			],
			{
				page: 1,
				totalItems: 4,
				totalPages: 2,
				hasNextPage: true,
			},
		));
	});
}

describe('AdminProjectsPage pagination query contract', () => {
	beforeEach(() => {
		mocks.useMe.mockReturnValue({
			user: { id: 1, email: 'admin@pcu.ac.kr', name: '관리자', role: 'ADMIN' },
		});
		mocks.getProjects.mockResolvedValue(response([project()]));
		mocks.bulkStatus.mockResolvedValue({ updated: 1 });
		mocks.bulkDelete.mockResolvedValue({ deleted: 1, assetsRemoved: 0 });
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it('changes API query params and resets page when search changes', async () => {
		mockPagedProjects();
		renderPage();

		await expectProjectVisible('Alpha Project');
		fireEvent.click(screen.getByRole('button', { name: '다음' }));
		await expectProjectVisible('Gamma Project');

		fireEvent.change(screen.getByPlaceholderText('제목, 요약, 이름, 학번 검색...'), {
			target: { value: 'Dragon' },
		});

		await waitFor(() => {
			expect(mocks.getProjects).toHaveBeenLastCalledWith(expect.objectContaining({
				page: 1,
				limit: 20,
				search: 'Dragon',
			}));
		});
	});

	it('changes API query params when filters and sort change', async () => {
		renderPage();

		await expectProjectVisible('Alpha Project');
		fireEvent.change(screen.getByLabelText('연도 필터'), {
			target: { value: '2024' },
		});

		await waitFor(() => {
			expect(mocks.getProjects).toHaveBeenLastCalledWith(expect.objectContaining({
				year: 2024,
			}));
		});
		await expectProjectVisible('Alpha Project');

		fireEvent.click(screen.getByRole('button', { name: '보관' }));
		await waitFor(() => {
			expect(mocks.getProjects).toHaveBeenLastCalledWith(expect.objectContaining({
				year: 2024,
				status: 'ARCHIVED',
			}));
		});
		await expectProjectVisible('Alpha Project');

		fireEvent.click(screen.getByText('제목'));
		await waitFor(() => {
			expect(mocks.getProjects).toHaveBeenLastCalledWith(expect.objectContaining({
				year: 2024,
				status: 'ARCHIVED',
				sort: 'title',
				order: 'asc',
			}));
		});
	});

	it('changes API query params and replaces the list when page changes', async () => {
		mockPagedProjects();
		renderPage();

		await expectProjectVisible('Alpha Project');
		fireEvent.click(screen.getByRole('button', { name: '다음' }));

		await waitFor(() => {
			expect(mocks.getProjects).toHaveBeenLastCalledWith(expect.objectContaining({
				page: 2,
				limit: 20,
			}));
		});
		await expectProjectVisible('Gamma Project');
		expect(screen.queryAllByText('Alpha Project')).toHaveLength(0);
	});

	it('keeps bulk selection scoped to the current page items', async () => {
		mockPagedProjects();
		renderPage();

		await expectProjectVisible('Alpha Project');
		fireEvent.click(screen.getAllByRole('checkbox')[0]);
		expect(screen.getByText('2개 선택')).toBeTruthy();

		fireEvent.click(screen.getByRole('button', { name: '다음' }));
		await expectProjectVisible('Gamma Project');
		expect(screen.queryByText('2개 선택')).toBeNull();

		fireEvent.click(screen.getAllByRole('checkbox')[0]);
		const archiveButtons = screen.getAllByRole('button', { name: '보관' });
		fireEvent.click(archiveButtons[archiveButtons.length - 1]);

		await waitFor(() => {
			expect(mocks.bulkStatus).toHaveBeenCalledWith([3, 4], 'ARCHIVED');
		});
	});

	it('keeps the empty state for empty server pages', async () => {
		mocks.getProjects.mockResolvedValue(response([], {
			page: 1,
			totalItems: 0,
			totalPages: 0,
		}));

		renderPage();

		expect(await screen.findByText('조건에 맞는 작품이 없습니다.')).toBeTruthy();
		expect(screen.getByText('0 / 0')).toBeTruthy();
	});
});
