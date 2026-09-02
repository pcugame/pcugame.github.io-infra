/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DirectImageUploadWidget from '../components/DirectImageUploadWidget';
import { YearMobileCard } from '../features/admin/exhibitions/ExhibitionRows';

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

describe('DirectImageUploadWidget', () => {
	it('uses an exhibition-owned POSTER direct multipart session and waits for worker readiness', async () => {
		uploadDirectAssetFile.mockResolvedValue({ status: 'VERIFYING', sessionId: 'poster-1', generation: 1, sizeBytes: 1 });
		waitForDirectAssetReady.mockResolvedValue({ state: 'READY' });
		const complete = vi.fn();
		const { container } = render(
			<QueryClientProvider client={new QueryClient()}>
				<DirectImageUploadWidget owner={{ type: 'EXHIBITION', id: 44 }} kind="POSTER" onComplete={complete} />
			</QueryClientProvider>,
		);

		const file = new File(['poster'], 'poster.webp', { type: 'image/webp' });
		const input = container.querySelector('input[type="file"]');
		expect(input).not.toBeNull();
		fireEvent.change(input!, { target: { files: [file] } });
		fireEvent.click(screen.getByRole('button', { name: '포스터 업로드 시작' }));

		await waitFor(() => expect(complete).toHaveBeenCalledOnce());
		expect(uploadDirectAssetFile).toHaveBeenCalledWith(
			{ type: 'EXHIBITION', id: 44 }, file, 'POSTER', expect.any(Function), expect.any(Object),
		);
		expect(waitForDirectAssetReady).toHaveBeenCalledWith('poster-1', { signal: expect.any(AbortSignal) });
	});

	it('wires exhibition poster management to the direct widget rather than the legacy FormData route', async () => {
		uploadDirectAssetFile.mockResolvedValue({ status: 'VERIFYING', sessionId: 'poster-2', generation: 1, sizeBytes: 1 });
		waitForDirectAssetReady.mockResolvedValue({ state: 'READY' });
		const { container } = render(
			<QueryClientProvider client={new QueryClient()}>
				<YearMobileCard
					year={{ id: 45, year: 2026, title: 'Direct poster', isUploadEnabled: true, sortOrder: 0, projectCount: 0 }}
					isEditing={false}
					onEdit={vi.fn()} onCancel={vi.fn()} onSaved={vi.fn()} onDelete={vi.fn()} isDeleting={false}
					isAdmin={false} onExport={vi.fn()} isExporting={false} isAnyExporting={false}
				/>
			</QueryClientProvider>,
		);

		const file = new File(['poster'], 'direct-poster.webp', { type: 'image/webp' });
		fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
		fireEvent.click(screen.getByRole('button', { name: '포스터 업로드 시작' }));
		await waitFor(() => expect(uploadDirectAssetFile).toHaveBeenCalled());
		expect(uploadDirectAssetFile.mock.calls[0]?.slice(0, 3)).toEqual([
			{ type: 'EXHIBITION', id: 45 }, file, 'POSTER',
		]);
	});

	it('aborts an in-flight image upload on unmount without deleting its resumable server session', async () => {
		const session = {
			sessionId: 'image-unmount', owner: { type: 'PROJECT', id: 4 }, generation: 1, partSizeBytes: 16,
			totalParts: 1, expiresAt: '2026-08-22T00:00:00.000Z', sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'd'.repeat(64), kind: 'IMAGE',
		};
		let options: { signal: AbortSignal } | undefined;
		uploadDirectAssetFile.mockImplementation((_owner, _file, _kind, _onProgress, uploadOptions) => {
			options = uploadOptions;
			uploadOptions.onSession(session);
			return new Promise(() => undefined);
		});
		const { container, unmount } = render(
			<QueryClientProvider client={new QueryClient()}>
				<DirectImageUploadWidget owner={{ type: 'PROJECT', id: 4 }} kind="IMAGE" />
			</QueryClientProvider>,
		);
		const file = new File(['image'], 'cover.png', { type: 'image/png' });
		fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
		fireEvent.click(screen.getByRole('button', { name: '이미지 업로드 시작' }));
		await waitFor(() => expect(options).toBeDefined());
		unmount();

		expect(options?.signal.aborted).toBe(true);
		expect(cancelDirectAssetUploadSession).not.toHaveBeenCalled();
		expect(JSON.parse(window.sessionStorage.getItem('pcu.direct-image-upload:PROJECT:4') ?? '{}')).toMatchObject({
			session: { sessionId: 'image-unmount' },
		});
	});

	it('waits for locator restoration before auto-starting and resumes at the saved absolute file index', async () => {
		const first = new File(['first'], 'first.png', { type: 'image/png' });
		const second = new File(['second'], 'second.png', { type: 'image/png' });
		const third = new File(['third'], 'third.png', { type: 'image/png' });
		const session = {
			sessionId: 'image-second', owner: { type: 'PROJECT', id: 4 }, generation: 1, partSizeBytes: 16,
			totalParts: 1, expiresAt: '2026-08-22T00:00:00.000Z', sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'e'.repeat(64), kind: 'IMAGE',
		};
		window.sessionStorage.setItem('pcu.direct-image-upload:PROJECT:4', JSON.stringify({
			session, originalName: second.name, totalBytes: second.size, completed: 1,
		}));
		let resolveRestore: ((status: typeof session & { state: 'UPLOADING' }) => void) | undefined;
		getDirectAssetUploadStatus
			.mockImplementationOnce(() => new Promise((resolve) => { resolveRestore = resolve; }))
			.mockResolvedValueOnce({ ...session, state: 'UPLOADING', originalName: second.name, totalBytes: second.size, parts: [] });
		uploadDirectAssetFile
			.mockResolvedValueOnce({ status: 'VERIFYING', sessionId: session.sessionId })
			.mockResolvedValueOnce({ status: 'READY', sessionId: 'image-third' });
		waitForDirectAssetReady.mockResolvedValue({ state: 'READY' });
		const complete = vi.fn();

		render(
			<QueryClientProvider client={new QueryClient()}>
				<DirectImageUploadWidget
					owner={{ type: 'PROJECT', id: 4 }} kind="IMAGE" initialFiles={[first, second, third]} autoStart
					submissionItems={[
						{ id: 'item-first', clientToken: 'first' },
						{ id: 'item-second', clientToken: 'second' },
						{ id: 'item-third', clientToken: 'third' },
					]}
					onComplete={complete}
				/>
			</QueryClientProvider>,
		);

		expect(uploadDirectAssetFile).not.toHaveBeenCalled();
		await act(async () => {
			resolveRestore?.({ ...session, state: 'UPLOADING' });
		});
		await waitFor(() => expect(complete).toHaveBeenCalledOnce());
		expect(uploadDirectAssetFile.mock.calls.map((call) => call[1].name)).toEqual(['second.png', 'third.png']);
		expect(uploadDirectAssetFile.mock.calls[0]?.[4]).toMatchObject({
			resume: session,
			submissionItem: { id: 'item-second', clientToken: 'second' },
			signal: expect.any(AbortSignal),
		});
		expect(uploadDirectAssetFile.mock.calls[1]?.[4]).toMatchObject({
			submissionItem: { id: 'item-third', clientToken: 'third' },
			signal: expect.any(AbortSignal),
		});
	});

	it('treats a restored READY current file as completed before starting the remaining queue', async () => {
		const first = new File(['first'], 'first.png', { type: 'image/png' });
		const second = new File(['second'], 'second.png', { type: 'image/png' });
		const session = {
			sessionId: 'image-ready', owner: { type: 'PROJECT', id: 4 }, generation: 1, partSizeBytes: 16,
			totalParts: 1, expiresAt: '2026-08-22T00:00:00.000Z', sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'f'.repeat(64), kind: 'IMAGE',
		};
		window.sessionStorage.setItem('pcu.direct-image-upload:PROJECT:4', JSON.stringify({
			session, originalName: first.name, totalBytes: first.size, completed: 0,
		}));
		getDirectAssetUploadStatus.mockResolvedValue({ ...session, state: 'READY', originalName: first.name, totalBytes: first.size, parts: [] });
		let resolveSecond: ((completion: { status: 'READY'; sessionId: string }) => void) | undefined;
		uploadDirectAssetFile.mockImplementation(() => new Promise((resolve) => { resolveSecond = resolve; }));
		const complete = vi.fn();

		render(
			<QueryClientProvider client={new QueryClient()}>
				<DirectImageUploadWidget owner={{ type: 'PROJECT', id: 4 }} kind="IMAGE" initialFiles={[first, second]} autoStart onComplete={complete} />
			</QueryClientProvider>,
		);

		await waitFor(() => expect(uploadDirectAssetFile).toHaveBeenCalledOnce());
		expect(uploadDirectAssetFile.mock.calls[0]?.[1]).toBe(second);
		expect(complete).not.toHaveBeenCalled();
		await act(async () => {
			resolveSecond?.({ status: 'READY', sessionId: 'image-second-ready' });
		});
		await waitFor(() => expect(complete).toHaveBeenCalledOnce());
	});

	it('keeps a late session locator visible after pause, without treating the abort as an error', async () => {
		const session = {
			sessionId: 'image-pause', owner: { type: 'PROJECT', id: 4 }, generation: 1, partSizeBytes: 16,
			totalParts: 1, expiresAt: '2026-08-22T00:00:00.000Z', sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'g'.repeat(64), kind: 'IMAGE',
		};
		let options: { signal: AbortSignal; onSession: (next: typeof session) => void } | undefined;
		uploadDirectAssetFile.mockImplementation((_owner, _file, _kind, _onProgress, nextOptions) => {
			options = nextOptions;
			return new Promise(() => undefined);
		});
		const { container } = render(
			<QueryClientProvider client={new QueryClient()}>
				<DirectImageUploadWidget owner={{ type: 'PROJECT', id: 4 }} kind="IMAGE" />
			</QueryClientProvider>,
		);
		const file = new File(['image'], 'cover.png', { type: 'image/png' });
		fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
		fireEvent.click(screen.getByRole('button', { name: '이미지 업로드 시작' }));
		await waitFor(() => expect(options).toBeDefined());
		fireEvent.click(screen.getByRole('button', { name: '일시 정지' }));
		expect(options?.signal.aborted).toBe(true);
		options?.onSession(session);

		await waitFor(() => expect(screen.getByRole('button', { name: '이어올리기' })).toBeTruthy());
		expect(window.sessionStorage.getItem('pcu.direct-image-upload:PROJECT:4')).toContain('image-pause');
		expect(screen.queryByText(/abort/i)).toBeNull();
	});

	it('polls after a failed cancellation and retains the locator when both DELETE and GET fail', async () => {
		const session = {
			sessionId: 'image-cancel', owner: { type: 'PROJECT', id: 4 }, generation: 1, partSizeBytes: 16,
			totalParts: 1, expiresAt: '2026-08-22T00:00:00.000Z', sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'h'.repeat(64), kind: 'IMAGE',
		};
		window.sessionStorage.setItem('pcu.direct-image-upload:PROJECT:4', JSON.stringify({
			session, originalName: 'cover.png', totalBytes: 5, completed: 0,
		}));
		getDirectAssetUploadStatus
			.mockResolvedValueOnce({ ...session, state: 'UPLOADING', originalName: 'cover.png', totalBytes: 5, parts: [] })
			.mockRejectedValueOnce(new Error('status unavailable'));
		cancelDirectAssetUploadSession.mockRejectedValueOnce(new Error('conflict'));
		render(
			<QueryClientProvider client={new QueryClient()}>
				<DirectImageUploadWidget owner={{ type: 'PROJECT', id: 4 }} kind="IMAGE" />
			</QueryClientProvider>,
		);

		await waitFor(() => expect(screen.getByRole('button', { name: '취소' })).toBeTruthy());
		fireEvent.click(screen.getByRole('button', { name: '취소' }));
		await waitFor(() => expect(cancelDirectAssetUploadSession).toHaveBeenCalledWith('image-cancel'));
		await waitFor(() => expect(getDirectAssetUploadStatus).toHaveBeenCalledTimes(2));
		expect(window.sessionStorage.getItem('pcu.direct-image-upload:PROJECT:4')).toContain('image-cancel');
		expect(screen.getByText('중단된 업로드가 있습니다. 동일한 파일을 다시 선택해 재개하세요.')).toBeTruthy();
	});

	it('removes the locator only when a failed cancellation is confirmed as CANCELLED', async () => {
		const session = {
			sessionId: 'image-cancelled', owner: { type: 'PROJECT', id: 4 }, generation: 1, partSizeBytes: 16,
			totalParts: 1, expiresAt: '2026-08-22T00:00:00.000Z', sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'i'.repeat(64), kind: 'IMAGE',
		};
		window.sessionStorage.setItem('pcu.direct-image-upload:PROJECT:4', JSON.stringify({
			session, originalName: 'cover.png', totalBytes: 5, completed: 0,
		}));
		getDirectAssetUploadStatus
			.mockResolvedValueOnce({ ...session, state: 'UPLOADING', originalName: 'cover.png', totalBytes: 5, parts: [] })
			.mockResolvedValueOnce({ ...session, state: 'CANCELLED', originalName: 'cover.png', totalBytes: 5, parts: [] });
		cancelDirectAssetUploadSession.mockRejectedValueOnce(new Error('conflict'));
		render(
			<QueryClientProvider client={new QueryClient()}>
				<DirectImageUploadWidget owner={{ type: 'PROJECT', id: 4 }} kind="IMAGE" />
			</QueryClientProvider>,
		);

		await waitFor(() => expect(screen.getByRole('button', { name: '취소' })).toBeTruthy());
		fireEvent.click(screen.getByRole('button', { name: '취소' }));
		await waitFor(() => expect(getDirectAssetUploadStatus).toHaveBeenCalledTimes(2));
		expect(window.sessionStorage.getItem('pcu.direct-image-upload:PROJECT:4')).toBeNull();
	});

	it('cancels exactly once when a create session arrives after local cancellation', async () => {
		const session = {
			sessionId: 'image-late-cancel', owner: { type: 'PROJECT', id: 4 }, generation: 1, partSizeBytes: 16,
			totalParts: 1, expiresAt: '2026-08-22T00:00:00.000Z', sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'j'.repeat(64), kind: 'IMAGE',
		};
		let options: { signal: AbortSignal; onSession: (next: typeof session) => void } | undefined;
		let resolveDelete: (() => void) | undefined;
		uploadDirectAssetFile.mockImplementation((_owner, _file, _kind, _onProgress, nextOptions) => {
			options = nextOptions;
			return new Promise(() => undefined);
		});
		cancelDirectAssetUploadSession.mockImplementation(() => new Promise<void>((resolve) => { resolveDelete = resolve; }));
		const { container } = render(
			<QueryClientProvider client={new QueryClient()}>
				<DirectImageUploadWidget owner={{ type: 'PROJECT', id: 4 }} kind="IMAGE" />
			</QueryClientProvider>,
		);
		const file = new File(['image'], 'cover.png', { type: 'image/png' });
		fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
		fireEvent.click(screen.getByRole('button', { name: '이미지 업로드 시작' }));
		await waitFor(() => expect(options).toBeDefined());
		fireEvent.click(screen.getByRole('button', { name: '취소' }));
		expect(options?.signal.aborted).toBe(true);
		options?.onSession(session);

		expect(window.sessionStorage.getItem('pcu.direct-image-upload:PROJECT:4')).toContain('image-late-cancel');
		await waitFor(() => expect(cancelDirectAssetUploadSession).toHaveBeenCalledTimes(1));
		expect(cancelDirectAssetUploadSession).toHaveBeenCalledWith('image-late-cancel');
		await act(async () => { resolveDelete?.(); });
		await waitFor(() => expect(window.sessionStorage.getItem('pcu.direct-image-upload:PROJECT:4')).toBeNull());
	});

	it('persists a late create locator after unmount without issuing a DELETE or updating the UI', async () => {
		const session = {
			sessionId: 'image-late-unmount', owner: { type: 'PROJECT', id: 4 }, generation: 1, partSizeBytes: 16,
			totalParts: 1, expiresAt: '2026-08-22T00:00:00.000Z', sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'k'.repeat(64), kind: 'IMAGE',
		};
		let options: { signal: AbortSignal; onSession: (next: typeof session) => void } | undefined;
		uploadDirectAssetFile.mockImplementation((_owner, _file, _kind, _onProgress, nextOptions) => {
			options = nextOptions;
			return new Promise(() => undefined);
		});
		const { container, unmount } = render(
			<QueryClientProvider client={new QueryClient()}>
				<DirectImageUploadWidget owner={{ type: 'PROJECT', id: 4 }} kind="IMAGE" />
			</QueryClientProvider>,
		);
		const file = new File(['image'], 'cover.png', { type: 'image/png' });
		fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
		fireEvent.click(screen.getByRole('button', { name: '이미지 업로드 시작' }));
		await waitFor(() => expect(options).toBeDefined());
		unmount();
		options?.onSession(session);

		expect(options?.signal.aborted).toBe(true);
		expect(cancelDirectAssetUploadSession).not.toHaveBeenCalled();
		expect(JSON.parse(window.sessionStorage.getItem('pcu.direct-image-upload:PROJECT:4') ?? '{}')).toMatchObject({
			session: { sessionId: 'image-late-unmount' },
		});
	});
});
