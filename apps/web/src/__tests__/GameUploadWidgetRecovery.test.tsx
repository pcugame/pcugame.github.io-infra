/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({
	getStatus: vi.fn(),
	waitReady: vi.fn(),
	upload: vi.fn(),
	cancel: vi.fn(),
}));

vi.mock('../lib/api/game-upload', () => ({
	getDirectAssetUploadStatus: controls.getStatus,
	waitForDirectAssetReady: controls.waitReady,
	uploadDirectAssetFile: controls.upload,
	cancelDirectAssetUploadSession: controls.cancel,
}));

import GameUploadWidget from '../components/GameUploadWidget';

describe('GAME/WebGL direct upload reload recovery', () => {
	afterEach(() => {
		cleanup();
		window.sessionStorage.clear();
		vi.clearAllMocks();
	});

	it('keeps a COMPLETING WebGL session and resumes background status polling after reload', async () => {
		const saved = {
			sessionId: 'webgl-long', owner: { type: 'PROJECT', id: 7 }, generation: 1,
			partSizeBytes: 16 * 1024 * 1024, totalParts: 320,
			expiresAt: '2026-08-22T00:00:00.000Z', sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1',
			sourceIdentity: 'a'.repeat(64), kind: 'WEBGL',
		};
		window.sessionStorage.setItem('pcu.direct-asset-upload:7:WEBGL', JSON.stringify(saved));
		controls.getStatus.mockResolvedValue({ ...saved, state: 'COMPLETING', originalName: 'webgl.zip', totalBytes: 5, parts: [] });
		controls.waitReady.mockResolvedValue({ ...saved, state: 'READY', originalName: 'webgl.zip', totalBytes: 5, parts: [] });
		const onComplete = vi.fn();
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

		render(
			<QueryClientProvider client={queryClient}>
				<GameUploadWidget projectId={7} uploadKind="WEBGL" onComplete={onComplete} />
			</QueryClientProvider>,
		);

		expect(await screen.findByText('업로드 완료')).toBeTruthy();
		expect(controls.waitReady).toHaveBeenCalledWith('webgl-long', {
			signal: expect.any(AbortSignal),
		});
		expect(window.sessionStorage.getItem('pcu.direct-asset-upload:7:WEBGL')).toBeNull();
		expect(onComplete).toHaveBeenCalledOnce();
		queryClient.clear();
	});

	it('pauses local work without losing its locator and ignores late upload callbacks', async () => {
		const saved = {
			sessionId: 'game-pause', owner: { type: 'PROJECT', id: 7 }, generation: 1,
			partSizeBytes: 16, totalParts: 2, expiresAt: '2026-08-22T00:00:00.000Z',
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'b'.repeat(64), kind: 'GAME',
		};
		let progress: ((next: { percent: number; uploadedChunks: number; totalChunks: number; uploadedBytes: number; totalBytes: number }) => void) | undefined;
		let options: { signal: AbortSignal; onSession: (session: typeof saved) => void } | undefined;
		let resolveUpload: ((value: { status: 'VERIFYING'; sessionId: string }) => void) | undefined;
		controls.upload.mockImplementation((_projectId, _file, _kind, onProgress, uploadOptions) => {
			progress = onProgress;
			options = uploadOptions;
			return new Promise((resolve) => { resolveUpload = resolve; });
		});
		const file = new File(['game'], 'game.zip', { type: 'application/zip' });
		render(
			<QueryClientProvider client={new QueryClient()}>
				<GameUploadWidget projectId={7} initialFile={file} autoStart />
			</QueryClientProvider>,
		);

		await screen.findByRole('button', { name: '일시 정지' });
		fireEvent.click(screen.getByRole('button', { name: '일시 정지' }));
		expect(options?.signal.aborted).toBe(true);
		options?.onSession(saved);
		expect(JSON.parse(window.sessionStorage.getItem('pcu.direct-asset-upload:7:GAME') ?? '{}')).toMatchObject({ sessionId: 'game-pause' });
		expect(screen.getByRole('button', { name: '업로드 시작' })).toBeTruthy();

		await act(async () => {
			progress?.({ percent: 100, uploadedChunks: 2, totalChunks: 2, uploadedBytes: 2, totalBytes: 2 });
			resolveUpload?.({ status: 'VERIFYING', sessionId: 'game-pause' });
		});
		expect(controls.waitReady).not.toHaveBeenCalled();
		expect(screen.queryByText('업로드 완료')).toBeNull();
	});

	it('aborts local work before one server cancellation and clears the locator only after success', async () => {
		const saved = {
			sessionId: 'game-cancel', owner: { type: 'PROJECT', id: 7 }, generation: 1,
			partSizeBytes: 16, totalParts: 2, expiresAt: '2026-08-22T00:00:00.000Z',
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'c'.repeat(64), kind: 'GAME',
		};
		let options: { signal: AbortSignal } | undefined;
		controls.upload.mockImplementation((_projectId, _file, _kind, _onProgress, uploadOptions) => {
			options = uploadOptions;
			uploadOptions.onSession(saved);
			return new Promise(() => undefined);
		});
		controls.cancel.mockResolvedValue(undefined);
		const file = new File(['game'], 'game.zip', { type: 'application/zip' });
		render(
			<QueryClientProvider client={new QueryClient()}>
				<GameUploadWidget projectId={7} initialFile={file} autoStart />
			</QueryClientProvider>,
		);

		await screen.findByRole('button', { name: '취소 (세션 삭제)' });
		fireEvent.click(screen.getByRole('button', { name: '취소 (세션 삭제)' }));
		await waitFor(() => expect(controls.cancel).toHaveBeenCalledOnce());
		expect(controls.cancel).toHaveBeenCalledWith('game-cancel');
		expect(options?.signal.aborted).toBe(true);
		await waitFor(() => expect(window.sessionStorage.getItem('pcu.direct-asset-upload:7:GAME')).toBeNull());
	});

	it('checks a resumed session status and observes VERIFYING without restarting multipart upload', async () => {
		const saved = {
			sessionId: 'game-verifying', owner: { type: 'PROJECT', id: 7 }, generation: 1,
			partSizeBytes: 16, totalParts: 2, expiresAt: '2026-08-22T00:00:00.000Z',
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'e'.repeat(64), kind: 'GAME',
		};
		window.sessionStorage.setItem('pcu.direct-asset-upload:7:GAME', JSON.stringify(saved));
		controls.getStatus
			.mockResolvedValueOnce({ ...saved, state: 'UPLOADING', originalName: 'game.zip', totalBytes: 4, parts: [] })
			.mockResolvedValueOnce({ ...saved, state: 'VERIFYING', originalName: 'game.zip', totalBytes: 4, parts: [] });
		controls.waitReady.mockResolvedValue({ ...saved, state: 'READY', originalName: 'game.zip', totalBytes: 4, parts: [] });
		const file = new File(['game'], 'game.zip', { type: 'application/zip' });
		render(
			<QueryClientProvider client={new QueryClient()}>
				<GameUploadWidget projectId={7} initialFile={file} />
			</QueryClientProvider>,
		);

		await screen.findByRole('button', { name: '이어올리기' });
		fireEvent.click(screen.getByRole('button', { name: '이어올리기' }));
		await waitFor(() => expect(controls.getStatus).toHaveBeenCalledTimes(2));
		expect(controls.upload).not.toHaveBeenCalled();
		expect(controls.waitReady).toHaveBeenCalledWith('game-verifying', { signal: expect.any(AbortSignal) });
		expect(await screen.findByText('업로드 완료')).toBeTruthy();
	});

	it('keeps its locator after a failed delete until a status read confirms cancellation', async () => {
		const saved = {
			sessionId: 'game-cancelled', owner: { type: 'PROJECT', id: 7 }, generation: 1,
			partSizeBytes: 16, totalParts: 1, expiresAt: '2026-08-22T00:00:00.000Z',
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'f'.repeat(64), kind: 'GAME',
		};
		controls.upload.mockImplementation((_projectId, _file, _kind, _onProgress, options) => {
			options.onSession(saved);
			return new Promise(() => undefined);
		});
		controls.cancel.mockRejectedValue(new Error('conflict'));
		controls.getStatus.mockResolvedValue({ ...saved, state: 'CANCELLED', originalName: 'game.zip', totalBytes: 4, parts: [] });
		const file = new File(['game'], 'game.zip', { type: 'application/zip' });
		render(
			<QueryClientProvider client={new QueryClient()}>
				<GameUploadWidget projectId={7} initialFile={file} autoStart />
			</QueryClientProvider>,
		);

		await screen.findByRole('button', { name: '취소 (세션 삭제)' });
		fireEvent.click(screen.getByRole('button', { name: '취소 (세션 삭제)' }));
		await waitFor(() => expect(controls.getStatus).toHaveBeenCalledWith('game-cancelled'));
		await waitFor(() => expect(window.sessionStorage.getItem('pcu.direct-asset-upload:7:GAME')).toBeNull());
	});

	it('starts signal-bound readiness polling when cancel loses a race to verification', async () => {
		const saved = {
			sessionId: 'game-cancel-verifying', owner: { type: 'PROJECT', id: 7 }, generation: 1,
			partSizeBytes: 16, totalParts: 1, expiresAt: '2026-08-22T00:00:00.000Z',
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'g'.repeat(64), kind: 'GAME',
		};
		controls.upload.mockImplementation((_projectId, _file, _kind, _onProgress, options) => {
			options.onSession(saved);
			return new Promise(() => undefined);
		});
		controls.cancel.mockRejectedValue(new Error('conflict'));
		controls.getStatus.mockResolvedValue({ ...saved, state: 'VERIFYING', originalName: 'game.zip', totalBytes: 4, parts: [] });
		controls.waitReady.mockResolvedValue({ ...saved, state: 'READY', originalName: 'game.zip', totalBytes: 4, parts: [] });
		const file = new File(['game'], 'game.zip', { type: 'application/zip' });
		render(
			<QueryClientProvider client={new QueryClient()}>
				<GameUploadWidget projectId={7} initialFile={file} autoStart />
			</QueryClientProvider>,
		);

		await screen.findByRole('button', { name: '취소 (세션 삭제)' });
		fireEvent.click(screen.getByRole('button', { name: '취소 (세션 삭제)' }));
		await waitFor(() => expect(controls.waitReady).toHaveBeenCalledWith('game-cancel-verifying', { signal: expect.any(AbortSignal) }));
		expect(await screen.findByText('업로드 완료')).toBeTruthy();
	});

	it('keeps a restored locator and avoids a new create when its status read is unavailable', async () => {
		const saved = {
			sessionId: 'game-status-unavailable', owner: { type: 'PROJECT', id: 7 }, generation: 1,
			partSizeBytes: 16, totalParts: 1, expiresAt: '2026-08-22T00:00:00.000Z',
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'h'.repeat(64), kind: 'GAME',
		};
		window.sessionStorage.setItem('pcu.direct-asset-upload:7:GAME', JSON.stringify(saved));
		controls.getStatus.mockRejectedValue(new Error('offline'));
		const file = new File(['game'], 'game.zip', { type: 'application/zip' });
		render(
			<QueryClientProvider client={new QueryClient()}>
				<GameUploadWidget projectId={7} initialFile={file} autoStart />
			</QueryClientProvider>,
		);

		await waitFor(() => expect(controls.getStatus).toHaveBeenCalledTimes(2));
		expect(controls.upload).not.toHaveBeenCalled();
		expect(window.sessionStorage.getItem('pcu.direct-asset-upload:7:GAME')).not.toBeNull();
	});

	it('forgets a restored CANCELLED locator and does not auto-resume it', async () => {
		const saved = {
			sessionId: 'game-restored-cancelled', owner: { type: 'PROJECT', id: 7 }, generation: 1,
			partSizeBytes: 16, totalParts: 1, expiresAt: '2026-08-22T00:00:00.000Z',
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'j'.repeat(64), kind: 'GAME',
		};
		window.sessionStorage.setItem('pcu.direct-asset-upload:7:GAME', JSON.stringify(saved));
		controls.getStatus.mockResolvedValue({ ...saved, state: 'CANCELLED', originalName: 'game.zip', totalBytes: 4, parts: [] });
		const file = new File(['game'], 'game.zip', { type: 'application/zip' });
		render(
			<QueryClientProvider client={new QueryClient()}>
				<GameUploadWidget projectId={7} initialFile={file} autoStart />
			</QueryClientProvider>,
		);

		await waitFor(() => expect(window.sessionStorage.getItem('pcu.direct-asset-upload:7:GAME')).toBeNull());
		expect(controls.upload).not.toHaveBeenCalled();
		expect(screen.getByRole('button', { name: '업로드 시작' })).toBeTruthy();
	});

	it('cancels exactly once when a locator arrives after the user cancels create work', async () => {
		const saved = {
			sessionId: 'game-late-cancel', owner: { type: 'PROJECT', id: 7 }, generation: 1,
			partSizeBytes: 16, totalParts: 1, expiresAt: '2026-08-22T00:00:00.000Z',
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'i'.repeat(64), kind: 'GAME',
		};
		let options: { signal: AbortSignal; onSession: (session: typeof saved) => void } | undefined;
		controls.upload.mockImplementation((_projectId, _file, _kind, _onProgress, uploadOptions) => {
			options = uploadOptions;
			return new Promise(() => undefined);
		});
		controls.cancel.mockResolvedValue(undefined);
		const file = new File(['game'], 'game.zip', { type: 'application/zip' });
		render(
			<QueryClientProvider client={new QueryClient()}>
				<GameUploadWidget projectId={7} initialFile={file} autoStart />
			</QueryClientProvider>,
		);

		await screen.findByRole('button', { name: '취소 (세션 삭제)' });
		fireEvent.click(screen.getByRole('button', { name: '취소 (세션 삭제)' }));
		expect(options?.signal.aborted).toBe(true);
		expect(controls.cancel).not.toHaveBeenCalled();
		options?.onSession(saved);
		await waitFor(() => expect(controls.cancel).toHaveBeenCalledTimes(1));
		expect(controls.cancel).toHaveBeenCalledWith('game-late-cancel');
		await waitFor(() => expect(window.sessionStorage.getItem('pcu.direct-asset-upload:7:GAME')).toBeNull());
	});
});
