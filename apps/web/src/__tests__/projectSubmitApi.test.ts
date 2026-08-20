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
		const payload = {
			exhibitionId: 1,
			title: 'Game',
			members: [{ name: 'Student', studentId: '20260001' }],
		};
		const idempotencyKey = 'user-operation-key';

		await getProjectSubmitApi('user').submit({ payload, idempotencyKey });

		expect(mocks.api.post).toHaveBeenCalledWith(
			'/api/me/projects/submit',
			payload,
			expect.objectContaining({
				headers: { 'Idempotency-Key': idempotencyKey },
			}),
		);
	});

	it('/admin/projects/new admin mode submits to the admin endpoint', async () => {
		const payload = {
			exhibitionId: 1,
			title: 'Game',
			members: [{ name: 'Student', studentId: '20260001' }],
		};
		const idempotencyKey = 'admin-operation-key';

		await getProjectSubmitApi('admin').submit({ payload, idempotencyKey });

		expect(mocks.api.post).toHaveBeenCalledWith(
			'/api/admin/projects/submit',
			payload,
			expect.objectContaining({
				headers: { 'Idempotency-Key': idempotencyKey },
			}),
		);
	});
});
