/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DirectVideoUploadWidget from '../components/DirectVideoUploadWidget';

const { uploadDirectAssetFile, waitForDirectAssetReady, getDirectAssetUploadStatus, cancelDirectAssetUploadSession } = vi.hoisted(() => ({
	uploadDirectAssetFile: vi.fn(),
	waitForDirectAssetReady: vi.fn(),
	getDirectAssetUploadStatus: vi.fn(),
	cancelDirectAssetUploadSession: vi.fn(),
}));

vi.mock('../lib/api/game-upload', () => ({
	uploadDirectAssetFile,
	waitForDirectAssetReady,
	getDirectAssetUploadStatus,
	cancelDirectAssetUploadSession,
}));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	window.sessionStorage.clear();
});

describe('DirectVideoUploadWidget', () => {
	it('uploads multiple selected VIDEO files sequentially through canonical direct sessions', async () => {
		uploadDirectAssetFile
			.mockResolvedValueOnce({ status: 'VERIFYING', sessionId: 'video-1', generation: 1, sizeBytes: 1 })
			.mockResolvedValueOnce({ status: 'VERIFYING', sessionId: 'video-2', generation: 1, sizeBytes: 1 });
		waitForDirectAssetReady.mockResolvedValue({ state: 'READY' });
		getDirectAssetUploadStatus.mockResolvedValue({ state: 'READY' });
		const done = vi.fn();
		const first = new File(['a'], 'first.mp4', { type: 'video/mp4' });
		const second = new File(['b'], 'second.webm', { type: 'video/webm' });
		render(
			<QueryClientProvider client={new QueryClient()}>
				<DirectVideoUploadWidget projectId={77} initialFiles={[first, second]} autoStart onComplete={done} />
			</QueryClientProvider>,
		);

		await waitFor(() => expect(done).toHaveBeenCalledOnce());
		expect(uploadDirectAssetFile.mock.calls.map((call) => [call[0], call[1].name, call[2]])).toEqual([
			[77, 'first.mp4', 'VIDEO'],
			[77, 'second.webm', 'VIDEO'],
		]);
		expect(waitForDirectAssetReady).toHaveBeenNthCalledWith(1, 'video-1', { signal: expect.any(AbortSignal) });
		expect(waitForDirectAssetReady).toHaveBeenNthCalledWith(2, 'video-2', { signal: expect.any(AbortSignal) });
	});

	it('pauses the current file without starting the next one, then resumes from the completed offset', async () => {
		const first = new File(['a'], 'first.mp4', { type: 'video/mp4' });
		const second = new File(['b'], 'second.webm', { type: 'video/webm' });
		const firstSession = {
			sessionId: 'video-first', owner: { type: 'PROJECT', id: 77 }, generation: 1, partSizeBytes: 16,
			totalParts: 1, expiresAt: '2026-08-22T00:00:00.000Z', sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'a'.repeat(64), kind: 'VIDEO',
		};
		const secondSession = { ...firstSession, sessionId: 'video-second', sourceIdentity: 'b'.repeat(64) };
		getDirectAssetUploadStatus.mockResolvedValue({ ...secondSession, state: 'UPLOADING', originalName: second.name, totalBytes: second.size, parts: [] });
		let secondOptions: { signal: AbortSignal } | undefined;
		uploadDirectAssetFile.mockImplementation((_projectId, file, _kind, _onProgress, options) => {
			if (file === first) {
				options.onSession(firstSession);
				return Promise.resolve({ status: 'VERIFYING', sessionId: 'video-first' });
			}
			if (!secondOptions) {
				secondOptions = options;
				options.onSession(secondSession);
				_onProgress({ percent: 50, uploadedBytes: 1, totalBytes: 2, uploadedChunks: 0, totalChunks: 1 });
				return new Promise(() => undefined);
			}
			return Promise.resolve({ status: 'VERIFYING', sessionId: 'video-second' });
		});
		waitForDirectAssetReady.mockResolvedValue({ state: 'READY' });
		render(
			<QueryClientProvider client={new QueryClient()}>
				<DirectVideoUploadWidget
					projectId={77}
					initialFiles={[first, second]}
					autoStart
					submissionItems={[{ id: 'item-1', clientToken: 'one' }, { id: 'item-2', clientToken: 'two' }]}
				/>
			</QueryClientProvider>,
		);

		await waitFor(() => expect(uploadDirectAssetFile).toHaveBeenCalledTimes(2));
		expect(screen.getByRole('progressbar')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: '일시 정지' }));
		expect(screen.queryByRole('progressbar')).toBeNull();
		expect(screen.queryByText('업로드 중…')).toBeNull();
		expect(secondOptions?.signal.aborted).toBe(true);
		expect(uploadDirectAssetFile).toHaveBeenCalledTimes(2);
		expect(screen.getByText('2개 동영상 선택됨 (1/2 완료)')).toBeTruthy();

		fireEvent.click(screen.getByRole('button', { name: '이어올리기' }));
		await waitFor(() => expect(uploadDirectAssetFile).toHaveBeenCalledTimes(3));
		expect(uploadDirectAssetFile.mock.calls[2]?.slice(0, 3)).toEqual([77, second, 'VIDEO']);
		expect(uploadDirectAssetFile.mock.calls[2]?.[4]).toMatchObject({
			resume: secondSession,
			submissionItem: { id: 'item-2', clientToken: 'two' },
			signal: expect.any(AbortSignal),
		});
	});

	it('observes a resumed VERIFYING session instead of attempting another VIDEO multipart upload', async () => {
		const file = new File(['a'], 'clip.mp4', { type: 'video/mp4' });
		const session = {
			sessionId: 'video-verifying', owner: { type: 'PROJECT', id: 77 }, generation: 1, partSizeBytes: 16,
			totalParts: 1, expiresAt: '2026-08-22T00:00:00.000Z', sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'c'.repeat(64), kind: 'VIDEO',
		};
		uploadDirectAssetFile.mockImplementation((_projectId, _file, _kind, _onProgress, options) => {
			options.onSession(session);
			return new Promise(() => undefined);
		});
		getDirectAssetUploadStatus.mockResolvedValue({ ...session, state: 'VERIFYING', originalName: file.name, totalBytes: file.size, parts: [] });
		waitForDirectAssetReady.mockResolvedValue({ ...session, state: 'READY', originalName: file.name, totalBytes: file.size, parts: [] });
		render(
			<QueryClientProvider client={new QueryClient()}>
				<DirectVideoUploadWidget projectId={77} initialFiles={[file]} autoStart />
			</QueryClientProvider>,
		);

		await screen.findByRole('button', { name: '일시 정지' });
		fireEvent.click(screen.getByRole('button', { name: '일시 정지' }));
		fireEvent.click(screen.getByRole('button', { name: '이어올리기' }));
		await waitFor(() => expect(waitForDirectAssetReady).toHaveBeenCalledWith('video-verifying', { signal: expect.any(AbortSignal) }));
		expect(uploadDirectAssetFile).toHaveBeenCalledTimes(1);
		expect(await screen.findByText('동영상 업로드 완료')).toBeTruthy();
	});

	it('preserves restored completed offset when status is unavailable and never starts a fresh upload', async () => {
		const first = new File(['a'], 'first.mp4', { type: 'video/mp4' });
		const current = new File(['b'], 'current.webm', { type: 'video/webm' });
		const saved = {
			session: {
				sessionId: 'video-status-unavailable', owner: { type: 'PROJECT', id: 77 }, generation: 1, partSizeBytes: 16,
				totalParts: 1, expiresAt: '2026-08-22T00:00:00.000Z', sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'd'.repeat(64), kind: 'VIDEO',
			},
			originalName: current.name, totalBytes: current.size, completed: 1,
		};
		window.sessionStorage.setItem('pcu.direct-video-upload:77', JSON.stringify(saved));
		getDirectAssetUploadStatus.mockRejectedValue(new Error('offline'));
		render(
			<QueryClientProvider client={new QueryClient()}>
				<DirectVideoUploadWidget projectId={77} initialFiles={[first, current]} autoStart />
			</QueryClientProvider>,
		);

		await waitFor(() => expect(getDirectAssetUploadStatus).toHaveBeenCalledTimes(2));
		expect(uploadDirectAssetFile).not.toHaveBeenCalled();
		expect(screen.getByText('2개 동영상 선택됨 (1/2 완료)')).toBeTruthy();
		expect(window.sessionStorage.getItem('pcu.direct-video-upload:77')).not.toBeNull();
	});

	it('continues remaining files when cancel loses a race to READY', async () => {
		const first = new File(['a'], 'first.mp4', { type: 'video/mp4' });
		const current = new File(['b'], 'current.webm', { type: 'video/webm' });
		const remaining = new File(['c'], 'remaining.mp4', { type: 'video/mp4' });
		const firstSession = {
			sessionId: 'video-ready-first', owner: { type: 'PROJECT', id: 77 }, generation: 1, partSizeBytes: 16,
			totalParts: 1, expiresAt: '2026-08-22T00:00:00.000Z', sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'e'.repeat(64), kind: 'VIDEO',
		};
		const currentSession = { ...firstSession, sessionId: 'video-ready-current', sourceIdentity: 'f'.repeat(64) };
		const remainingSession = { ...firstSession, sessionId: 'video-ready-remaining', sourceIdentity: 'g'.repeat(64) };
		uploadDirectAssetFile.mockImplementation((_projectId, file, _kind, _onProgress, options) => {
			if (file === first) {
				options.onSession(firstSession);
				return Promise.resolve({ status: 'VERIFYING', sessionId: firstSession.sessionId });
			}
			if (file === current) {
				options.onSession(currentSession);
				return new Promise(() => undefined);
			}
			options.onSession(remainingSession);
			return Promise.resolve({ status: 'VERIFYING', sessionId: remainingSession.sessionId });
		});
		waitForDirectAssetReady.mockResolvedValue({ state: 'READY' });
		cancelDirectAssetUploadSession.mockRejectedValue(new Error('conflict'));
		getDirectAssetUploadStatus.mockResolvedValue({ ...currentSession, state: 'READY', originalName: current.name, totalBytes: current.size, parts: [] });
		render(
			<QueryClientProvider client={new QueryClient()}>
				<DirectVideoUploadWidget projectId={77} initialFiles={[first, current, remaining]} autoStart />
			</QueryClientProvider>,
		);

		await waitFor(() => expect(uploadDirectAssetFile).toHaveBeenCalledTimes(2));
		fireEvent.click(screen.getByRole('button', { name: '취소' }));
		await waitFor(() => expect(uploadDirectAssetFile).toHaveBeenCalledTimes(3));
		expect(uploadDirectAssetFile.mock.calls[2]?.slice(0, 3)).toEqual([77, remaining, 'VIDEO']);
		expect(await screen.findByText('동영상 업로드 완료')).toBeTruthy();
	});
});
