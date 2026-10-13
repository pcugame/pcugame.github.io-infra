/* @vitest-environment jsdom */
import { resetDirectUploadTasksForTests } from '../lib/upload/directUploadTask';
afterEach(resetDirectUploadTasksForTests);


import { webcrypto } from 'node:crypto';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DirectImageUploadWidget from '../components/DirectImageUploadWidget';

function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify({ ok: true, data }), {
		status: init.status ?? 200,
		statusText: init.statusText,
		headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
	});
}

describe('IMAGE direct upload recovery', () => {
	let installedBlobArrayBuffer = false;
	afterEach(() => {
		cleanup();
		window.sessionStorage.clear();
		if (installedBlobArrayBuffer) {
			delete (Blob.prototype as Partial<Blob>).arrayBuffer;
			installedBlobArrayBuffer = false;
		}
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('persists a late direct create locator and issues the pending cancellation through the real client', async () => {
		vi.stubGlobal('crypto', webcrypto as unknown as Crypto);
		if (typeof Blob.prototype.arrayBuffer !== 'function') {
			installedBlobArrayBuffer = true;
			Object.defineProperty(Blob.prototype, 'arrayBuffer', {
				configurable: true,
				value(this: Blob) {
					return new Promise<ArrayBuffer>((resolve, reject) => {
						const reader = new FileReader();
						reader.onerror = () => reject(reader.error);
						reader.onload = () => resolve(reader.result as ArrayBuffer);
						reader.readAsArrayBuffer(this);
					});
				},
			});
		}
		let markCreateStarted!: () => void;
		const createStarted = new Promise<void>((resolve) => { markCreateStarted = resolve; });
		let finishCreate!: (response: Response) => void;
		const createResponse = new Promise<Response>((resolve) => { finishCreate = resolve; });
		let markDeleteStarted!: () => void;
		const deleteStarted = new Promise<void>((resolve) => { markDeleteStarted = resolve; });
		const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
			const url = String(request);
			if (url.endsWith('/api/admin/projects/7/direct-image-upload-sessions')) {
				markCreateStarted();
				return createResponse;
			}
			if (url.endsWith('/api/admin/direct-asset-upload-sessions/session-widget-late') && init?.method === 'DELETE') {
				expect(JSON.parse(window.sessionStorage.getItem('pcu.direct-image-upload:PROJECT:7') ?? '{}'))
					.toMatchObject({ session: { sessionId: 'session-widget-late' } });
				markDeleteStarted();
				return new Response(null, { status: 204 });
			}
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);
		const file = new File(['image'], 'cover.png', { type: 'image/png' });

		const cancelled = vi.fn();
		const completed = vi.fn();
		render(
			<QueryClientProvider client={new QueryClient()}>
				<DirectImageUploadWidget owner={{ type: 'PROJECT', id: 7 }} kind="IMAGE" initialFiles={[file]} autoStart onCancelled={cancelled} onComplete={completed} />
			</QueryClientProvider>,
		);

		await createStarted;
		fireEvent.click(await screen.findByRole('button', { name: '취소' }));
		expect(cancelled).not.toHaveBeenCalled();
		await act(async () => {
			finishCreate(jsonResponse({
				sessionId: 'session-widget-late', owner: { type: 'PROJECT', id: 7 }, generation: 1,
				partSizeBytes: 4, totalParts: 1, expiresAt: '2026-08-22T00:00:00.000Z',
				sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'a'.repeat(64),
			}));
			await deleteStarted;
		});

		await waitFor(() => expect(window.sessionStorage.getItem('pcu.direct-image-upload:PROJECT:7')).toBeNull());
		expect(cancelled).toHaveBeenCalledOnce();
		expect(completed).not.toHaveBeenCalled();
		expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
		expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/part-urls'))).toBe(false);
	});

});
