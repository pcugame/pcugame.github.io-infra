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

function directSession(sessionId: string) {
	return {
		sessionId, owner: { type: 'PROJECT', id: 7 }, generation: 1,
		partSizeBytes: 4, totalParts: 1, expiresAt: '2026-08-22T00:00:00.000Z',
		sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'a'.repeat(64),
		kind: 'GAME', originalName: 'game.zip', totalBytes: 4, parts: [],
	};
}

describe('GAME upload real-client state machine', () => {
	let installedBlobArrayBuffer = false;
	function installBrowserCrypto() {
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
	}

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

	it('keeps a restored verifying locator in an actionable error state when polling fails', async () => {
		const saved = directSession('restore-verifying-error');
		window.sessionStorage.setItem('pcu.direct-asset-upload:7:GAME', JSON.stringify(saved));
		let statusReads = 0;
		const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
			const url = String(request);
			if (url.endsWith('/api/admin/direct-asset-upload-sessions/restore-verifying-error') && init?.method === 'DELETE') {
				return new Response(null, { status: 204 });
			}
			if (url.endsWith('/api/admin/direct-asset-upload-sessions/restore-verifying-error')) {
				statusReads += 1;
				if (statusReads === 1) return jsonResponse({ ...saved, state: 'VERIFYING' });
				return new Response(JSON.stringify({ ok: false }), { status: 400, statusText: 'Polling failed' });
			}
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);

		render(
			<QueryClientProvider client={new QueryClient()}>
				<GameUploadWidget projectId={7} initialFile={new File(['game'], 'game.zip')} />
			</QueryClientProvider>,
		);

		expect(await screen.findByRole('button', { name: '재시도' })).toBeTruthy();
		expect(screen.getByRole('button', { name: '취소 (세션 삭제)' })).toBeTruthy();
		expect(window.sessionStorage.getItem('pcu.direct-asset-upload:7:GAME')).not.toBeNull();
		fireEvent.click(screen.getByRole('button', { name: '취소 (세션 삭제)' }));
		await waitFor(() => expect(window.sessionStorage.getItem('pcu.direct-asset-upload:7:GAME')).toBeNull());
	});

	it('does not auto-create after a restored CANCELLED status, including the next timer tick', async () => {
		installBrowserCrypto();
		const saved = directSession('restore-cancelled');
		window.sessionStorage.setItem('pcu.direct-asset-upload:7:GAME', JSON.stringify(saved));
		const fetchMock = vi.fn(async (request: string | URL | Request) => {
			const url = String(request);
			if (url.endsWith('/api/admin/direct-asset-upload-sessions/restore-cancelled')) {
				return jsonResponse({ ...saved, state: 'CANCELLED' });
			}
			if (url.endsWith('/api/admin/projects/7/direct-game-upload-sessions')) {
				throw new Error('unexpected auto-restart');
			}
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);

		render(
			<QueryClientProvider client={new QueryClient()}>
				<GameUploadWidget projectId={7} initialFile={new File(['game'], 'game.zip')} autoStart />
			</QueryClientProvider>,
		);

		await waitFor(() => expect(window.sessionStorage.getItem('pcu.direct-asset-upload:7:GAME')).toBeNull());
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/direct-game-upload-sessions'))).toBe(false);
	});

	it('does not let paused upload A overwrite the newer upload B locator', async () => {
		installBrowserCrypto();
		let createCount = 0;
		let markFirstCreateStarted!: () => void;
		const firstCreateStarted = new Promise<void>((resolve) => { markFirstCreateStarted = resolve; });
		let finishFirstCreate!: (response: Response) => void;
		const firstCreateResponse = new Promise<Response>((resolve) => { finishFirstCreate = resolve; });
		const pendingCapability = new Promise<Response>(() => undefined);
		const fetchMock = vi.fn(async (request: string | URL | Request) => {
			const url = String(request);
			if (url.endsWith('/api/admin/projects/7/direct-game-upload-sessions')) {
				createCount += 1;
				if (createCount === 1) {
					markFirstCreateStarted();
					return firstCreateResponse;
				}
				return jsonResponse(directSession('session-b'));
			}
			if (url.endsWith('/part-urls')) return pendingCapability;
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);
		const file = new File(['game'], 'game.zip', { type: 'application/zip' });

		render(
			<QueryClientProvider client={new QueryClient()}>
				<GameUploadWidget projectId={7} initialFile={file} autoStart />
			</QueryClientProvider>,
		);

		await firstCreateStarted;
		fireEvent.click(await screen.findByRole('button', { name: '일시 정지' }));
		fireEvent.click(await screen.findByRole('button', { name: '업로드 시작' }));
		await waitFor(() => expect(JSON.parse(window.sessionStorage.getItem('pcu.direct-asset-upload:7:GAME') ?? '{}'))
			.toMatchObject({ sessionId: 'session-b' }));
		await act(async () => { finishFirstCreate(jsonResponse(directSession('session-a'))); });
		expect(JSON.parse(window.sessionStorage.getItem('pcu.direct-asset-upload:7:GAME') ?? '{}'))
			.toMatchObject({ sessionId: 'session-b' });
	});

	it('converges a late cancellation to completed when DELETE loses to READY', async () => {
		installBrowserCrypto();
		let markCreateStarted!: () => void;
		const createStarted = new Promise<void>((resolve) => { markCreateStarted = resolve; });
		let finishCreate!: (response: Response) => void;
		const createResponse = new Promise<Response>((resolve) => { finishCreate = resolve; });
		const saved = directSession('late-ready');
		const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
			const url = String(request);
			if (url.endsWith('/api/admin/projects/7/direct-game-upload-sessions')) {
				markCreateStarted();
				return createResponse;
			}
			if (url.endsWith('/api/admin/direct-asset-upload-sessions/late-ready') && init?.method === 'DELETE') {
				return new Response(JSON.stringify({ ok: false }), { status: 409, statusText: 'Conflict' });
			}
			if (url.endsWith('/api/admin/direct-asset-upload-sessions/late-ready')) {
				return jsonResponse({ ...saved, state: 'READY' });
			}
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);
		const onComplete = vi.fn();

		render(
			<QueryClientProvider client={new QueryClient()}>
				<GameUploadWidget projectId={7} initialFile={new File(['game'], 'game.zip')} autoStart onComplete={onComplete} />
			</QueryClientProvider>,
		);

		await createStarted;
		fireEvent.click(await screen.findByRole('button', { name: '취소 (세션 삭제)' }));
		await act(async () => { finishCreate(jsonResponse(saved)); });
		expect(await screen.findByText('업로드 완료')).toBeTruthy();
		expect(window.sessionStorage.getItem('pcu.direct-asset-upload:7:GAME')).toBeNull();
		expect(onComplete).toHaveBeenCalledOnce();
		expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/part-urls'))).toBe(false);
	});

});
