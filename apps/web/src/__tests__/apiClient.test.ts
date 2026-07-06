import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, getApiErrorCode, getApiErrorMessage, isApiError } from '../lib/api/client';

function jsonResponse(body: unknown, init: ResponseInit = {}) {
	return new Response(JSON.stringify(body), {
		status: init.status ?? 200,
		statusText: init.statusText,
		headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
	});
}

describe('api client request helpers', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('unwraps successful API envelopes and includes credentials', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
			ok: true,
			data: { id: 1, title: 'Project' },
		}));
		vi.stubGlobal('fetch', fetchMock);

		await expect(api.get('/api/projects/1')).resolves.toEqual({ id: 1, title: 'Project' });
		expect(fetchMock).toHaveBeenCalledWith('http://localhost:4000/api/projects/1', expect.objectContaining({
			method: 'GET',
			credentials: 'include',
		}));
	});

	it('serializes JSON request bodies and sets Content-Type', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, data: { saved: true } }));
		vi.stubGlobal('fetch', fetchMock);

		await api.post('/api/projects', { title: 'Project' });

		const [, init] = fetchMock.mock.calls[0]!;
		expect(init.body).toBe(JSON.stringify({ title: 'Project' }));
		expect((init.headers as Headers).get('Content-Type')).toBe('application/json');
	});

	it('does not set a JSON Content-Type for FormData bodies', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, data: { uploaded: true } }));
		vi.stubGlobal('fetch', fetchMock);
		const formData = new FormData();
		formData.append('payload', '{}');

		await api.post('/api/upload', formData);

		const [, init] = fetchMock.mock.calls[0]!;
		expect(init.body).toBe(formData);
		expect((init.headers as Headers).get('Content-Type')).toBeNull();
	});

	it('returns undefined for 204 responses', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

		await expect(api.delete('/api/projects/1')).resolves.toBeUndefined();
	});

	it('throws ApiError with parsed JSON error payloads', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
			ok: false,
			error: { code: 'FORBIDDEN', message: 'No access' },
		}, { status: 403, statusText: 'Forbidden' })));

		await expect(api.get('/api/private')).rejects.toMatchObject({
			status: 403,
			statusText: 'Forbidden',
			body: {
				ok: false,
				error: { code: 'FORBIDDEN', message: 'No access' },
			},
		});
	});
});

describe('api error helpers', () => {
	it('reads structured error code and message', () => {
		const err = new ApiError(403, 'Forbidden', {
			error: { code: 'EMAIL_DOMAIN_NOT_ALLOWED', message: 'School account required' },
		});

		expect(isApiError(err)).toBe(true);
		expect(getApiErrorCode(err)).toBe('EMAIL_DOMAIN_NOT_ALLOWED');
		expect(getApiErrorMessage(err)).toBe('School account required');
	});

	it('falls back to body message, status text, Error message, and generic message', () => {
		expect(getApiErrorMessage(new ApiError(400, 'Bad Request', { message: 'Invalid body' }))).toBe('Invalid body');
		expect(getApiErrorMessage(new ApiError(500, 'Server Error', null))).toBe('Server Error');
		expect(getApiErrorMessage(new Error('Network failed'))).toBe('Network failed');
		expect(getApiErrorMessage('bad')).toBe('알 수 없는 오류가 발생했습니다.');
	});
});
