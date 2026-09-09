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
			if (url.endsWith('/api/admin/projects/7/game-upload-sessions')) return jsonResponse({ items: [] });
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
			if (url.endsWith('/api/admin/projects/7/game-upload-sessions')) return jsonResponse({ items: [] });
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
			if (url.endsWith('/api/admin/projects/7/game-upload-sessions')) return jsonResponse({ items: [] });
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
			if (url.endsWith('/api/admin/projects/7/game-upload-sessions')) return jsonResponse({ items: [] });
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

	it('resumes legacy chunks with startFrom and completes without re-uploading finished chunks', async () => {
		const legacy = {
			sessionId: 'legacy-complete', originalName: 'legacy.zip', totalBytes: 6,
			chunkSizeBytes: 3, totalChunks: 2, uploadedChunks: [0], uploadedCount: 1,
			status: 'PENDING', expiresAt: '2026-08-22T00:00:00.000Z', uploadKind: 'GAME',
		};
		const fetchMock = vi.fn(async (request: string | URL | Request) => {
			const url = String(request);
			if (url.endsWith('/api/admin/projects/7/game-upload-sessions')) return jsonResponse({ items: [legacy] });
			if (url.endsWith('/api/admin/game-upload-sessions/legacy-complete')) return jsonResponse(legacy);
			if (url.endsWith('/chunks/1')) return jsonResponse({ chunkIndex: 1 });
			if (url.endsWith('/complete')) return jsonResponse({ project: {} });
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);
		const { container } = render(
			<QueryClientProvider client={new QueryClient()}>
				<GameUploadWidget projectId={7} />
			</QueryClientProvider>,
		);

		await screen.findByText(/미완료 업로드가 있습니다/);
		fireEvent.change(container.querySelector('input[type="file"]')!, {
			target: { files: [new File(['legacy'], 'legacy.zip')] },
		});
		fireEvent.click(screen.getByRole('button', { name: '이어올리기' }));
		expect(await screen.findByText('업로드 완료')).toBeTruthy();
		const urls = fetchMock.mock.calls.map(([url]) => String(url));
		expect(urls.some((url) => url.endsWith('/chunks/0'))).toBe(false);
		expect(urls.filter((url) => url.endsWith('/chunks/1'))).toHaveLength(1);
		expect(urls.filter((url) => url.endsWith('/complete'))).toHaveLength(1);
	});

	it('does not offer pause or cancel while a legacy complete request is pending', async () => {
		const legacy = {
			sessionId: 'legacy-completing', originalName: 'legacy.zip', totalBytes: 3,
			chunkSizeBytes: 3, totalChunks: 1, uploadedChunks: [], uploadedCount: 0,
			status: 'PENDING', expiresAt: '2026-08-22T00:00:00.000Z', uploadKind: 'GAME',
		};
		let markCompleteStarted!: () => void;
		const completeStarted = new Promise<void>((resolve) => { markCompleteStarted = resolve; });
		let finishComplete!: (response: Response) => void;
		const completeResponse = new Promise<Response>((resolve) => { finishComplete = resolve; });
		const fetchMock = vi.fn(async (request: string | URL | Request) => {
			const url = String(request);
			if (url.endsWith('/api/admin/projects/7/game-upload-sessions')) return jsonResponse({ items: [legacy] });
			if (url.endsWith('/api/admin/game-upload-sessions/legacy-completing')) return jsonResponse(legacy);
			if (url.endsWith('/legacy-completing/chunks/0')) return jsonResponse({ chunkIndex: 0 });
			if (url.endsWith('/legacy-completing/complete')) {
				markCompleteStarted();
				return completeResponse;
			}
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);
		const { container } = render(
			<QueryClientProvider client={new QueryClient()}>
				<GameUploadWidget projectId={7} />
			</QueryClientProvider>,
		);

		await screen.findByText(/미완료 업로드가 있습니다/);
		fireEvent.change(container.querySelector('input[type="file"]')!, {
			target: { files: [new File(['zip'], 'legacy.zip')] },
		});
		fireEvent.click(screen.getByRole('button', { name: '이어올리기' }));
		await completeStarted;
		expect(await screen.findByText('파일 조립 중…')).toBeTruthy();
		expect(screen.queryByRole('button', { name: '일시 정지' })).toBeNull();
		expect(screen.queryByRole('button', { name: '취소 (세션 삭제)' })).toBeNull();
		await act(async () => { finishComplete(jsonResponse({ project: {} })); });
		expect(await screen.findByText('업로드 완료')).toBeTruthy();
	});

	it('pauses a legacy resume and then cancels it through the legacy endpoint', async () => {
		const legacy = {
			sessionId: 'legacy-pause', originalName: 'legacy.zip', totalBytes: 9,
			chunkSizeBytes: 3, totalChunks: 3, uploadedChunks: [0], uploadedCount: 1,
			status: 'PENDING', expiresAt: '2026-08-22T00:00:00.000Z', uploadKind: 'GAME',
		};
		let markChunkStarted!: () => void;
		const chunkStarted = new Promise<void>((resolve) => { markChunkStarted = resolve; });
		let finishChunk!: (response: Response) => void;
		const chunkResponse = new Promise<Response>((resolve) => { finishChunk = resolve; });
		const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
			const url = String(request);
			if (url.endsWith('/api/admin/projects/7/game-upload-sessions')) return jsonResponse({ items: [legacy] });
			if (url.endsWith('/api/admin/game-upload-sessions/legacy-pause') && init?.method === 'DELETE') return new Response(null, { status: 204 });
			if (url.endsWith('/api/admin/game-upload-sessions/legacy-pause')) return jsonResponse(legacy);
			if (url.endsWith('/chunks/1')) {
				markChunkStarted();
				return chunkResponse;
			}
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);
		const { container } = render(
			<QueryClientProvider client={new QueryClient()}>
				<GameUploadWidget projectId={7} />
			</QueryClientProvider>,
		);

		await screen.findByText(/미완료 업로드가 있습니다/);
		fireEvent.change(container.querySelector('input[type="file"]')!, {
			target: { files: [new File(['legacy!!!'], 'legacy.zip')] },
		});
		fireEvent.click(screen.getByRole('button', { name: '이어올리기' }));
		await chunkStarted;
		const pause = await screen.findByRole('button', { name: '일시 정지' });
		expect(screen.queryByRole('button', { name: '취소 (세션 삭제)' })).toBeNull();
		fireEvent.click(pause);
		expect(screen.queryByRole('button', { name: '취소 (세션 삭제)' })).toBeNull();
		await act(async () => { finishChunk(jsonResponse({ chunkIndex: 1 })); });
		fireEvent.click(await screen.findByRole('button', { name: '취소 (세션 삭제)' }));
		await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => (
			String(url).endsWith('/api/admin/game-upload-sessions/legacy-pause') && init?.method === 'DELETE'
		))).toBe(true));
		expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/chunks/2'))).toBe(false);
	});

	it('hides legacy resume controls and starts only one direct transport after 새로 시작', async () => {
		installBrowserCrypto();
		const legacy = {
			sessionId: 'legacy-new-start', originalName: 'legacy.zip', totalBytes: 6,
			chunkSizeBytes: 3, totalChunks: 2, uploadedChunks: [], uploadedCount: 0,
			status: 'PENDING', expiresAt: '2026-08-22T00:00:00.000Z', uploadKind: 'GAME',
		};
		let markCreateStarted!: () => void;
		const createStarted = new Promise<void>((resolve) => { markCreateStarted = resolve; });
		const pendingCreate = new Promise<Response>(() => undefined);
		const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
			const url = String(request);
			if (url.endsWith('/api/admin/projects/7/game-upload-sessions') && init?.method !== 'POST') return jsonResponse({ items: [legacy] });
			if (url.endsWith('/api/admin/projects/7/direct-game-upload-sessions')) {
				markCreateStarted();
				return pendingCreate;
			}
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);
		const { container } = render(
			<QueryClientProvider client={new QueryClient()}>
				<GameUploadWidget projectId={7} />
			</QueryClientProvider>,
		);

		await screen.findByText(/미완료 업로드가 있습니다/);
		fireEvent.change(container.querySelector('input[type="file"]')!, {
			target: { files: [new File(['legacy'], 'legacy.zip')] },
		});
		const start = screen.getByRole('button', { name: '새로 시작' });
		fireEvent.click(start);
		fireEvent.click(start);
		await createStarted;
		await waitFor(() => expect(screen.queryByRole('button', { name: '이어올리기' })).toBeNull());
		expect(screen.getByRole('button', { name: '일시 정지' })).toBeTruthy();
		expect(screen.getByRole('button', { name: '취소 (세션 삭제)' })).toBeTruthy();
		expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/direct-game-upload-sessions'))).toHaveLength(1);
		expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/game-upload-sessions/legacy-new-start'))).toBe(false);
	});

	it('keeps direct pause and cancel controls when a legacy list response arrives late', async () => {
		installBrowserCrypto();
		const legacy = {
			sessionId: 'legacy-late-list', originalName: 'legacy.zip', totalBytes: 6,
			chunkSizeBytes: 3, totalChunks: 2, uploadedChunks: [], uploadedCount: 0,
			status: 'PENDING', expiresAt: '2026-08-22T00:00:00.000Z', uploadKind: 'GAME',
		};
		let finishList!: (response: Response) => void;
		const listResponse = new Promise<Response>((resolve) => { finishList = resolve; });
		let markCreateStarted!: () => void;
		const createStarted = new Promise<void>((resolve) => { markCreateStarted = resolve; });
		const pendingCreate = new Promise<Response>(() => undefined);
		const fetchMock = vi.fn(async (request: string | URL | Request) => {
			const url = String(request);
			if (url.endsWith('/api/admin/projects/7/game-upload-sessions')) return listResponse;
			if (url.endsWith('/api/admin/projects/7/direct-game-upload-sessions')) {
				markCreateStarted();
				return pendingCreate;
			}
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);

		render(
			<QueryClientProvider client={new QueryClient()}>
				<GameUploadWidget projectId={7} initialFile={new File(['game'], 'game.zip')} autoStart />
			</QueryClientProvider>,
		);

		await createStarted;
		expect(await screen.findByRole('button', { name: '일시 정지' })).toBeTruthy();
		expect(screen.getByRole('button', { name: '취소 (세션 삭제)' })).toBeTruthy();
		await act(async () => { finishList(jsonResponse({ items: [legacy] })); });
		expect(screen.queryByRole('button', { name: '이어올리기' })).toBeNull();
		expect(screen.getByRole('button', { name: '일시 정지' })).toBeTruthy();
		expect(screen.getByRole('button', { name: '취소 (세션 삭제)' })).toBeTruthy();
	});

	it('single-flights a double-clicked legacy resume through status, chunks, and complete', async () => {
		const legacy = {
			sessionId: 'legacy-single-flight', originalName: 'legacy.zip', totalBytes: 6,
			chunkSizeBytes: 3, totalChunks: 2, uploadedChunks: [0], uploadedCount: 1,
			status: 'PENDING', expiresAt: '2026-08-22T00:00:00.000Z', uploadKind: 'GAME',
		};
		let finishStatus!: (response: Response) => void;
		const statusResponse = new Promise<Response>((resolve) => { finishStatus = resolve; });
		const fetchMock = vi.fn(async (request: string | URL | Request) => {
			const url = String(request);
			if (url.endsWith('/api/admin/projects/7/game-upload-sessions')) return jsonResponse({ items: [legacy] });
			if (url.endsWith('/api/admin/game-upload-sessions/legacy-single-flight')) return statusResponse;
			if (url.endsWith('/api/admin/projects/7/direct-game-upload-sessions')) throw new Error('direct start must be fenced');
			if (url.endsWith('/chunks/1')) return jsonResponse({ chunkIndex: 1 });
			if (url.endsWith('/complete')) return jsonResponse({ project: {} });
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);
		const { container } = render(
			<QueryClientProvider client={new QueryClient()}>
				<GameUploadWidget projectId={7} />
			</QueryClientProvider>,
		);

		await screen.findByText(/미완료 업로드가 있습니다/);
		fireEvent.change(container.querySelector('input[type="file"]')!, {
			target: { files: [new File(['legacy'], 'legacy.zip')] },
		});
		const resume = screen.getByRole('button', { name: '이어올리기' });
		const directStart = screen.getByRole('button', { name: '새로 시작' });
		fireEvent.click(resume);
		fireEvent.click(resume);
		fireEvent.click(directStart);
		await act(async () => { finishStatus(jsonResponse(legacy)); });
		expect(await screen.findByText('업로드 완료')).toBeTruthy();
		const urls = fetchMock.mock.calls.map(([url]) => String(url));
		expect(urls.filter((url) => url.endsWith('/game-upload-sessions/legacy-single-flight'))).toHaveLength(1);
		expect(urls.filter((url) => url.endsWith('/chunks/1'))).toHaveLength(1);
		expect(urls.filter((url) => url.endsWith('/complete'))).toHaveLength(1);
		expect(urls.filter((url) => url.endsWith('/direct-game-upload-sessions'))).toHaveLength(0);
	});

	it('replaces a non-pending legacy session once before uploading', async () => {
		const legacy = {
			sessionId: 'legacy-finished', originalName: 'legacy.zip', totalBytes: 6,
			chunkSizeBytes: 3, totalChunks: 2, uploadedChunks: [0, 1], uploadedCount: 2,
			status: 'COMPLETED', expiresAt: '2026-08-22T00:00:00.000Z', uploadKind: 'GAME',
		};
		const replacement = {
			sessionId: 'legacy-replacement', chunkSizeBytes: 6, totalChunks: 1,
			expiresAt: '2026-08-22T00:00:00.000Z', uploadKind: 'GAME',
		};
		const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
			const url = String(request);
			if (url.endsWith('/api/admin/projects/7/game-upload-sessions') && init?.method === 'POST') return jsonResponse(replacement);
			if (url.endsWith('/api/admin/projects/7/game-upload-sessions')) return jsonResponse({ items: [legacy] });
			if (url.endsWith('/api/admin/game-upload-sessions/legacy-finished')) return jsonResponse(legacy);
			if (url.endsWith('/api/admin/game-upload-sessions/legacy-replacement/chunks/0')) return jsonResponse({ chunkIndex: 0 });
			if (url.endsWith('/api/admin/game-upload-sessions/legacy-replacement/complete')) return jsonResponse({ project: {} });
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);
		const { container } = render(
			<QueryClientProvider client={new QueryClient()}>
				<GameUploadWidget projectId={7} />
			</QueryClientProvider>,
		);

		await screen.findByText(/미완료 업로드가 있습니다/);
		fireEvent.change(container.querySelector('input[type="file"]')!, {
			target: { files: [new File(['legacy'], 'legacy.zip')] },
		});
		fireEvent.click(screen.getByRole('button', { name: '이어올리기' }));
		expect(await screen.findByText('업로드 완료')).toBeTruthy();
		expect(fetchMock.mock.calls.filter(([url, init]) => (
			String(url).endsWith('/api/admin/projects/7/game-upload-sessions') && init?.method === 'POST'
		))).toHaveLength(1);
		const urls = fetchMock.mock.calls.map(([url]) => String(url));
		expect(urls.filter((url) => url.includes('/game-upload-sessions/legacy-replacement/'))).toEqual([
			expect.stringMatching(/\/legacy-replacement\/chunks\/0$/),
			expect.stringMatching(/\/legacy-replacement\/complete$/),
		]);
		expect(urls.some((url) => url.includes('/game-upload-sessions/legacy-finished/'))).toBe(false);
	});

	it('retries a failed replacement from its current uploadedChunks without creating another session', async () => {
		const original = {
			sessionId: 'legacy-old-complete', originalName: 'legacy.zip', totalBytes: 6,
			chunkSizeBytes: 3, totalChunks: 2, uploadedChunks: [0, 1], uploadedCount: 2,
			status: 'COMPLETED', expiresAt: '2026-08-22T00:00:00.000Z', uploadKind: 'GAME',
		};
		const replacement = {
			sessionId: 'legacy-current-replacement', originalName: 'legacy.zip', totalBytes: 6,
			chunkSizeBytes: 3, totalChunks: 2, uploadedChunks: [0], uploadedCount: 1,
			status: 'PENDING', expiresAt: '2026-08-22T00:00:00.000Z', uploadKind: 'GAME',
		};
		let completeCalls = 0;
		const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
			const url = String(request);
			if (url.endsWith('/api/admin/projects/7/game-upload-sessions') && init?.method === 'POST') return jsonResponse(replacement);
			if (url.endsWith('/api/admin/projects/7/game-upload-sessions')) return jsonResponse({ items: [original] });
			if (url.endsWith('/api/admin/game-upload-sessions/legacy-old-complete')) return jsonResponse(original);
			if (url.endsWith('/api/admin/game-upload-sessions/legacy-current-replacement')) return jsonResponse(replacement);
			if (url.endsWith('/api/admin/game-upload-sessions/legacy-current-replacement/chunks/0')) return jsonResponse({ chunkIndex: 0 });
			if (url.endsWith('/api/admin/game-upload-sessions/legacy-current-replacement/chunks/1')) return jsonResponse({ chunkIndex: 1 });
			if (url.endsWith('/api/admin/game-upload-sessions/legacy-current-replacement/complete')) {
				completeCalls += 1;
				if (completeCalls === 1) return new Response(JSON.stringify({ ok: false }), { status: 409, statusText: 'Conflict' });
				return jsonResponse({ project: {} });
			}
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);
		const { container } = render(
			<QueryClientProvider client={new QueryClient()}>
				<GameUploadWidget projectId={7} />
			</QueryClientProvider>,
		);

		await screen.findByText(/미완료 업로드가 있습니다/);
		fireEvent.change(container.querySelector('input[type="file"]')!, {
			target: { files: [new File(['legacy'], 'legacy.zip')] },
		});
		fireEvent.click(screen.getByRole('button', { name: '이어올리기' }));
		fireEvent.click(await screen.findByRole('button', { name: '재시도' }));
		expect(await screen.findByText('업로드 완료')).toBeTruthy();

		const calls = fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), init }));
		expect(calls.filter(({ url, init }) => url.endsWith('/api/admin/projects/7/game-upload-sessions') && init?.method === 'POST')).toHaveLength(1);
		expect(calls.filter(({ url }) => url.endsWith('/api/admin/game-upload-sessions/legacy-current-replacement'))).toHaveLength(1);
		expect(calls.filter(({ url }) => url.endsWith('/legacy-current-replacement/chunks/0'))).toHaveLength(1);
		expect(calls.filter(({ url }) => url.endsWith('/legacy-current-replacement/chunks/1'))).toHaveLength(2);
		expect(calls.filter(({ url }) => url.endsWith('/legacy-current-replacement/complete'))).toHaveLength(2);
	});

	it('allows a new direct upload after successful legacy cancellation', async () => {
		installBrowserCrypto();
		const legacy = {
			sessionId: 'legacy-cancel-restart', originalName: 'legacy.zip', totalBytes: 6,
			chunkSizeBytes: 3, totalChunks: 2, uploadedChunks: [], uploadedCount: 0,
			status: 'PENDING', expiresAt: '2026-08-22T00:00:00.000Z', uploadKind: 'GAME',
		};
		let markDirectCreate!: () => void;
		const directCreate = new Promise<void>((resolve) => { markDirectCreate = resolve; });
		const pendingCreate = new Promise<Response>(() => undefined);
		const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
			const url = String(request);
			if (url.endsWith('/api/admin/projects/7/game-upload-sessions')) return jsonResponse({ items: [legacy] });
			if (url.endsWith('/api/admin/game-upload-sessions/legacy-cancel-restart') && init?.method === 'DELETE') return new Response(null, { status: 204 });
			if (url.endsWith('/api/admin/game-upload-sessions/legacy-cancel-restart')) {
				return new Response(JSON.stringify({ ok: false }), { status: 503, statusText: 'Unavailable' });
			}
			if (url.endsWith('/api/admin/projects/7/direct-game-upload-sessions')) {
				markDirectCreate();
				return pendingCreate;
			}
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);
		const { container } = render(
			<QueryClientProvider client={new QueryClient()}>
				<GameUploadWidget projectId={7} />
			</QueryClientProvider>,
		);

		await screen.findByText(/미완료 업로드가 있습니다/);
		fireEvent.change(container.querySelector('input[type="file"]')!, {
			target: { files: [new File(['legacy'], 'legacy.zip')] },
		});
		fireEvent.click(screen.getByRole('button', { name: '이어올리기' }));
		fireEvent.click(await screen.findByRole('button', { name: '취소 (세션 삭제)' }));
		const restart = await screen.findByRole('button', { name: '업로드 시작' });
		fireEvent.click(restart);
		await directCreate;
	});
});
