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

class ResponseXHR {
	static response = { status: 200, statusText: 'OK', text: '' };
	upload = {};
	onload?: () => void;
	withCredentials = false;
	get status() { return ResponseXHR.response.status; }
	get statusText() { return ResponseXHR.response.statusText; }
	get responseText() { return ResponseXHR.response.text; }
	open() {}
	setRequestHeader() {}
	send() { queueMicrotask(() => this.onload?.()); }
}

describe.each(['fetch', 'xhr'] as const)('%s API response protocol', (transport) => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	async function send(status: number, text: string, statusText = 'OK', path = '/api/upload') {
		vi.stubEnv('VITE_MOCK', 'false');
		if (transport === 'fetch') {
			vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(status === 204 ? null : text, { status, statusText })));
			return api.post(path, {});
		}
		ResponseXHR.response = { status, text, statusText };
		vi.stubGlobal('XMLHttpRequest', ResponseXHR);
		const { uploadFormData } = await import('../lib/api/client');
		return uploadFormData(path, new FormData(), { title: 'Upload' });
	}

	it.each([
		['{"ok":true,"data":{"id":1}}', { id: 1 }],
		['{"ok":true,"data":null}', null],
		['{"id":1}', { id: 1 }],
		['[]', []],
		['false', false],
	])('reads successful JSON %s', async (text, expected) => {
		await expect(send(201, text)).resolves.toEqual(expected);
	});

	it('returns no content for 204', async () => {
		await expect(send(204, '')).resolves.toBeUndefined();
	});

	it.each(['', '<html>proxy response</html>', '{"ok":true,'])('rejects malformed success JSON %s', async (text) => {
		await expect(send(200, text)).rejects.toMatchObject({ name: 'ApiError', status: 200, statusText: 'Invalid JSON response', body: text });
	});

	it.each([
		['{"ok":false,"error":{"code":"FORBIDDEN","message":"Denied"}}', { ok: false, error: { code: 'FORBIDDEN', message: 'Denied' } }],
		['proxy unavailable', 'proxy unavailable'],
		['', ''],
	])('preserves failed response bodies %s', async (text, expected) => {
		await expect(send(403, text, 'Forbidden')).rejects.toMatchObject({ name: 'ApiError', status: 403, statusText: 'Forbidden', body: expected });
	});

	it('hydrates media envelopes before returning them', async () => {
		const payload = { ok: true, data: { poster: { original: { url: 'https://assets.test/poster.webp' }, renditions: [] } } };
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, data: { url: 'https://assets.test/authorized.webp' } }));
		vi.stubEnv('VITE_MOCK', 'false');
		if (transport === 'fetch') fetchMock.mockResolvedValueOnce(jsonResponse(payload));
		vi.stubGlobal('fetch', fetchMock);
		ResponseXHR.response = { status: 200, text: JSON.stringify(payload), statusText: 'OK' };
		vi.stubGlobal('XMLHttpRequest', ResponseXHR);
		const { uploadFormData } = await import('../lib/api/client');
		const response = transport === 'fetch' ? api.get('/api/admin/projects/1')
			: uploadFormData('/api/admin/projects/1', new FormData(), { title: 'Upload' });
		await expect(response).resolves.toMatchObject({ poster: { original: { url: 'https://assets.test/authorized.webp' } } });
	});
});
