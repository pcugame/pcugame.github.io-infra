/* @vitest-environment jsdom */

import { webcrypto } from 'node:crypto';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GameUploadWidget from '../components/GameUploadWidget';

function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify({ ok: true, data }), {
		status: init.status ?? 200,
		statusText: init.statusText,
		headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
	});
}

describe('GAME upload recovery with Phase 1 legacy compatibility', () => {
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
			if (url.endsWith('/api/admin/projects/7/game-upload-sessions')) {
				return jsonResponse({ items: [] });
			}
			if (url.endsWith('/api/admin/projects/7/direct-game-upload-sessions')) {
				markCreateStarted();
				return createResponse;
			}
			if (url.endsWith('/api/admin/direct-asset-upload-sessions/session-widget-late') && init?.method === 'DELETE') {
				expect(JSON.parse(window.sessionStorage.getItem('pcu.direct-asset-upload:7:GAME') ?? '{}'))
					.toMatchObject({ sessionId: 'session-widget-late' });
				markDeleteStarted();
				return new Response(null, { status: 204 });
			}
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);
		const file = new File(['game'], 'game.zip', { type: 'application/zip' });

		render(
			<QueryClientProvider client={new QueryClient()}>
				<GameUploadWidget projectId={7} initialFile={file} autoStart />
			</QueryClientProvider>,
		);

		await createStarted;
		fireEvent.click(await screen.findByRole('button', { name: '취소 (세션 삭제)' }));
		await act(async () => {
			finishCreate(jsonResponse({
				sessionId: 'session-widget-late', owner: { type: 'PROJECT', id: 7 }, generation: 1,
				partSizeBytes: 4, totalParts: 1, expiresAt: '2026-08-22T00:00:00.000Z',
				sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'a'.repeat(64),
			}));
			await deleteStarted;
		});

		await waitFor(() => expect(window.sessionStorage.getItem('pcu.direct-asset-upload:7:GAME')).toBeNull());
		expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
		expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/part-urls'))).toBe(false);
	});

	it('retains the Phase 1 legacy session banner, resume request, and cancel endpoint', async () => {
		const legacy = {
			sessionId: 'legacy-session', originalName: 'legacy.zip', totalBytes: 6,
			chunkSizeBytes: 3, totalChunks: 2, uploadedChunks: [], uploadedCount: 0,
			status: 'PENDING', expiresAt: '2026-08-22T00:00:00.000Z', uploadKind: 'GAME',
		};
		const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
			const url = String(request);
			if (url.endsWith('/api/admin/projects/7/game-upload-sessions')) {
				return jsonResponse({ items: [legacy] });
			}
			if (url.endsWith('/api/admin/game-upload-sessions/legacy-session') && init?.method === 'DELETE') {
				return new Response(null, { status: 204 });
			}
			if (url.endsWith('/api/admin/game-upload-sessions/legacy-session')) {
				return new Response(JSON.stringify({ ok: false }), {
					status: 503,
					statusText: 'Service Unavailable',
					headers: { 'content-type': 'application/json' },
				});
			}
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);
		const { container } = render(
			<QueryClientProvider client={new QueryClient()}>
				<GameUploadWidget projectId={7} />
			</QueryClientProvider>,
		);

		expect(await screen.findByText(/미완료 업로드가 있습니다/)).toBeTruthy();
		fireEvent.change(container.querySelector('input[type="file"]')!, {
			target: { files: [new File(['legacy'], 'legacy.zip', { type: 'application/zip' })] },
		});
		fireEvent.click(screen.getByRole('button', { name: '이어올리기' }));
		expect(await screen.findByText(/Service Unavailable/)).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: '취소 (세션 삭제)' }));

		await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => (
			String(url).endsWith('/api/admin/game-upload-sessions/legacy-session') && init?.method === 'DELETE'
		))).toBe(true));
	});
});
