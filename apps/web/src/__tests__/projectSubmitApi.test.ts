import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	uploadFormData: vi.fn().mockResolvedValue({ id: 1, slug: 'game', year: 2026, status: 'PUBLISHED' }),
	api: {
		get: vi.fn(),
		post: vi.fn(),
		patch: vi.fn(),
		delete: vi.fn(),
	},
}));

vi.mock('../lib/api/client', () => ({
	api: mocks.api,
	uploadFormData: mocks.uploadFormData,
	ApiError: class ApiError extends Error {},
	isApiError: vi.fn(),
	getApiErrorCode: vi.fn(),
	getApiErrorMessage: vi.fn(),
}));

import { getProjectSubmitApi } from '../lib/api/project-submit';

describe('project submit API selection', () => {
	it('/me/projects/new user mode submits to the me endpoint', async () => {
		const fd = new FormData();

		await getProjectSubmitApi('user').submit(fd);

		expect(mocks.uploadFormData).toHaveBeenCalledWith(
			'/api/me/projects/submit',
			fd,
			expect.any(Object),
		);
	});

	it('/admin/projects/new admin mode submits to the admin endpoint', async () => {
		const fd = new FormData();

		await getProjectSubmitApi('admin').submit(fd);

		expect(mocks.uploadFormData).toHaveBeenCalledWith(
			'/api/admin/projects/submit',
			fd,
			expect.any(Object),
		);
	});
});
