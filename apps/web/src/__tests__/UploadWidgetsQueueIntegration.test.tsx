/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DirectImageUploadWidget from '../components/DirectImageUploadWidget';
import DirectVideoUploadWidget from '../components/DirectVideoUploadWidget';
import GameUploadWidget from '../components/GameUploadWidget';
import type { DirectAssetUploadSession } from '../lib/api/game-upload';

const controls = vi.hoisted(() => ({ upload: vi.fn(), cancel: vi.fn(), status: vi.fn(), ready: vi.fn() }));
vi.mock('../lib/api/game-upload', () => ({
	uploadDirectAssetFile: controls.upload,
	cancelDirectAssetUploadSession: controls.cancel,
	getDirectAssetUploadStatus: controls.status,
	waitForDirectAssetReady: controls.ready,
}));

afterEach(() => {
	cleanup();
	vi.resetAllMocks();
	window.sessionStorage.clear();
});

describe.each(['IMAGE', 'VIDEO', 'GAME'] as const)('%s external queue integration', (kind) => {
	const file = new File(['asset'], kind === 'GAME' ? 'asset.zip' : kind === 'VIDEO' ? 'asset.mp4' : 'asset.png');
	const session: DirectAssetUploadSession = {
		sessionId: `queue-${kind}`, owner: { type: 'PROJECT', id: 73 }, kind, generation: 1,
		partSizeBytes: 16, totalParts: 1, expiresAt: '2026-10-01T00:00:00.000Z',
		sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'a'.repeat(64),
	};
	type Options = { signal: AbortSignal; onSession: (next: DirectAssetUploadSession) => void };
	function mount(onCancelled = vi.fn(), autoStart = false, onComplete = vi.fn()) {
		const props = { compact: true, autoStart, onCancelled, onComplete };
		return render(<QueryClientProvider client={new QueryClient()}>
			{kind === 'IMAGE' ? <DirectImageUploadWidget {...props} owner={{ type: 'PROJECT', id: 73 }} kind="IMAGE" initialFiles={[file]} />
				: kind === 'VIDEO' ? <DirectVideoUploadWidget {...props} projectId={73} initialFiles={[file]} />
					: <GameUploadWidget {...props} projectId={73} initialFile={file} />}
		</QueryClientProvider>);
	}
	function save(originalName: string, completed = 0) {
		const key = kind === 'GAME' ? 'pcu.direct-asset-upload:73:GAME'
			: kind === 'IMAGE' ? 'pcu.direct-image-upload:PROJECT:73' : 'pcu.direct-video-upload:73';
		window.sessionStorage.setItem(key, JSON.stringify(kind === 'GAME' ? session
			: { session, originalName, totalBytes: file.size, completed }));
	}

	if (kind !== 'GAME') it('starts a new file after a cancelled old batch without inheriting its offset', async () => {
		save('old-asset', 2);
		controls.status.mockResolvedValue({ ...session, state: 'CANCELLED' });
		controls.upload.mockImplementation(() => new Promise(() => undefined));
		const completed = vi.fn();
		mount(vi.fn(), true, completed);
		await waitFor(() => expect(controls.upload).toHaveBeenCalledOnce());
		expect(completed).not.toHaveBeenCalled();
	});

	if (kind === 'GAME') it.each(['READY', 'VERIFYING'])('does not trust a restored %s session after its initial status lookup failed', async state => {
		save('old-asset');
		controls.status.mockRejectedValueOnce(new Error('offline'))
			.mockResolvedValue({ ...session, state, originalName: 'old-asset', totalBytes: file.size });
		controls.ready.mockResolvedValue({ ...session, state: 'READY' });
		const completed = vi.fn();
		mount(vi.fn(), true, completed);
		await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('선택한 파일을 재시도'));
		expect(completed).not.toHaveBeenCalled();
	});
	if (kind === 'GAME') it.each(['READY', 'VERIFYING'])('checks identity when cancellation finds %s after an unavailable initial status', async state => {
		save('old-asset');
		controls.status.mockRejectedValueOnce(new Error('offline'))
			.mockResolvedValue({ ...session, state, originalName: 'old-asset', totalBytes: file.size });
		controls.cancel.mockRejectedValue(new Error('already completing'));
		controls.ready.mockResolvedValue({ ...session, state: 'READY' });
		const completed = vi.fn();
		mount(vi.fn(), false, completed);
		await screen.findByRole('button', { name: '이어올리기' });
		fireEvent.click(screen.getByRole('button', { name: /^취소/ }));
		await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('선택한 파일을 재시도'));
		expect(completed).not.toHaveBeenCalled();
	});

	it.each(['READY', 'VERIFYING'])('does not complete a new file when cancelling an unrelated UPLOADING session that becomes %s', async state => {
		save('old-asset');
		controls.status.mockResolvedValueOnce({ ...session, state: 'UPLOADING', originalName: 'old-asset', totalBytes: file.size })
			.mockResolvedValue({ ...session, state, originalName: 'old-asset', totalBytes: file.size });
		controls.cancel.mockRejectedValue(new Error('already completing'));
		controls.ready.mockResolvedValue({ ...session, state: 'READY' });
		controls.upload.mockImplementation(() => new Promise(() => undefined));
		const completed = vi.fn();
		mount(vi.fn(), false, completed);
		await screen.findByRole('button', { name: '이어올리기' });
		fireEvent.click(screen.getByRole('button', { name: /^취소/ }));
		await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('선택한 파일을 재시도'));
		expect(completed).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: '재시도' }));
		await waitFor(() => expect(controls.upload).toHaveBeenCalledOnce());
	});
	if (kind === 'GAME') it.each(['READY', 'VERIFYING'])('does not complete a new file when automatic resume observes unrelated %s', async state => {
		save('old-asset');
		controls.status.mockResolvedValueOnce({ ...session, state: 'UPLOADING', originalName: 'old-asset', totalBytes: file.size })
			.mockResolvedValue({ ...session, state, originalName: 'old-asset', totalBytes: file.size });
		controls.ready.mockResolvedValue({ ...session, state: 'READY' });
		const completed = vi.fn();
		mount(vi.fn(), true, completed);
		await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('선택한 파일을 재시도'));
		expect(completed).not.toHaveBeenCalled();
		expect(controls.upload).not.toHaveBeenCalled();
	});

	it.each(['READY', 'VERIFYING'])('uploads the chosen file after reconciling an unrelated saved %s file', async (state) => {
		save('old-asset');
		controls.status.mockResolvedValue({ ...session, state, originalName: 'old-asset', totalBytes: file.size });
		controls.ready.mockResolvedValue({ ...session, state: 'READY' });
		let resolveUpload!: (value: { status: 'READY'; sessionId: string }) => void;
		controls.upload.mockImplementation(() => new Promise((resolve) => { resolveUpload = resolve; }));
		const completed = vi.fn();
		mount(vi.fn(), true, completed);
		await waitFor(() => expect(controls.upload).toHaveBeenCalledOnce());
		expect(controls.upload.mock.calls[0]?.[1]).toBe(file);
		expect(controls.upload.mock.calls[0]?.[4].resume).toBeUndefined();
		expect(completed).not.toHaveBeenCalled();
		await act(async () => { resolveUpload({ status: 'READY', sessionId: 'new-asset' }); });
		expect(completed).toHaveBeenCalledOnce();
	});

	if (kind !== 'GAME') it('normalizes an old batch offset when a compact row resumes its matching file', async () => {
		save(file.name, 2);
		controls.status.mockResolvedValue({ ...session, state: 'UPLOADING', originalName: file.name, totalBytes: file.size });
		controls.upload.mockImplementation(() => new Promise(() => undefined));
		mount(vi.fn(), true);
		await waitFor(() => expect(controls.upload).toHaveBeenCalledOnce());
		expect(controls.upload.mock.calls[0]?.[4]).toMatchObject({ resume: session });
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('hides duplicate file information and cancels a chosen file without creating a session', async () => {
		const cancelled = vi.fn();
		const { container } = mount(cancelled);
		expect(container.querySelector('h3')).toBeNull();
		expect(container.querySelector('input[type="file"]')).toBeNull();
		expect(container.querySelector('.game-upload__file-summary')).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: /^취소/ }));
		expect(cancelled).toHaveBeenCalledOnce();
		expect(controls.cancel).not.toHaveBeenCalled();
		expect(controls.upload).not.toHaveBeenCalled();
	});

	it('retains retry and cancel controls after a failure before session creation', async () => {
		controls.upload.mockRejectedValue(new Error('create failed'));
		const cancelled = vi.fn();
		mount(cancelled, true);
		expect(await screen.findByRole('alert')).toBeTruthy();
		expect(screen.getByRole('button', { name: '재시도' })).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: /^취소/ }));
		expect(cancelled).toHaveBeenCalledOnce();
		expect(controls.cancel).not.toHaveBeenCalled();
	});

	it('preserves progress, pause, and resume controls in a compact row', async () => {
		controls.upload.mockImplementation((_owner, _file, _kind, progress, options: Options) => {
			options.onSession(session);
			progress({ percent: 40, uploadedBytes: 2, totalBytes: 5, uploadedChunks: 0, totalChunks: 1 });
			return new Promise(() => undefined);
		});
		controls.status.mockResolvedValue({ ...session, state: 'UPLOADING' });
		mount(vi.fn(), true);
		expect(await screen.findByRole('progressbar')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: '일시 정지' }));
		expect(screen.getByRole('button', { name: '이어올리기' })).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: '이어올리기' }));
		await waitFor(() => expect(controls.upload).toHaveBeenCalledTimes(2));
		expect(controls.upload.mock.calls[1]?.[4]).toMatchObject({ resume: session });
	});

	it('waits for late session creation and confirmed server cancellation before notifying the queue', async () => {
		let options!: Options;
		let resolveDelete!: () => void;
		controls.upload.mockImplementation((_owner, _file, _kind, _progress, next: Options) => {
			options = next;
			return new Promise(() => undefined);
		});
		controls.cancel.mockImplementation(() => new Promise<void>((resolve) => { resolveDelete = resolve; }));
		const cancelled = vi.fn();
		mount(cancelled, true);
		await screen.findByRole('button', { name: '일시 정지' });
		fireEvent.click(screen.getByRole('button', { name: /^취소/ }));
		expect(options.signal.aborted).toBe(true);
		expect(cancelled).not.toHaveBeenCalled();
		// A pending cancellation must also prevent a fresh create while its locator is unknown.
		fireEvent.click(screen.getByRole('button', { name: /시작/ }));
		expect(controls.upload).toHaveBeenCalledOnce();
		await act(async () => { options.onSession(session); });
		expect(controls.cancel).toHaveBeenCalledWith(session.sessionId);
		expect(cancelled).not.toHaveBeenCalled();
		await act(async () => { resolveDelete(); });
		expect(cancelled).toHaveBeenCalledOnce();
	});

	it('also waits for a paused pending create before treating cancellation as complete', async () => {
		let options!: Options;
		controls.upload.mockImplementation((_owner, _file, _kind, _progress, next: Options) => {
			options = next;
			return new Promise(() => undefined);
		});
		controls.cancel.mockResolvedValue(undefined);
		const cancelled = vi.fn();
		mount(cancelled, true);
		fireEvent.click(await screen.findByRole('button', { name: '일시 정지' }));
		fireEvent.click(screen.getByRole('button', { name: /^취소/ }));
		expect(cancelled).not.toHaveBeenCalled();
		await act(async () => { options.onSession(session); });
		expect(cancelled).toHaveBeenCalledOnce();
		expect(controls.cancel).toHaveBeenCalledWith(session.sessionId);
	});

	it('can retry failed late cancellation and notifies only after CANCELLED is confirmed', async () => {
		let options!: Options;
		controls.upload.mockImplementation((_owner, _file, _kind, _progress, next: Options) => {
			options = next;
			return new Promise(() => undefined);
		});
		controls.cancel.mockRejectedValue(new Error('delete unavailable'));
		controls.status.mockRejectedValueOnce(new Error('status unavailable'))
			.mockResolvedValueOnce({ ...session, state: 'CANCELLED' });
		const cancelled = vi.fn();
		mount(cancelled, true);
		await screen.findByRole('button', { name: '일시 정지' });
		fireEvent.click(screen.getByRole('button', { name: /^취소/ }));
		await act(async () => { options.onSession(session); });
		expect(await screen.findByRole('alert')).toBeTruthy();
		expect(cancelled).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: /^취소/ }));
		await waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
		expect(controls.cancel).toHaveBeenCalledTimes(2);
	});

	it('does not report cancellation when the server has already completed the file', async () => {
		controls.upload.mockImplementation((_owner, _file, _kind, _progress, options: Options) => {
			options.onSession(session);
			return new Promise(() => undefined);
		});
		controls.cancel.mockRejectedValue(new Error('conflict'));
		controls.status.mockResolvedValue({ ...session, state: 'READY' });
		controls.ready.mockResolvedValue({ ...session, state: 'READY' });
		const cancelled = vi.fn();
		const completed = vi.fn();
		mount(cancelled, true, completed);
		await screen.findByRole('button', { name: '일시 정지' });
		fireEvent.click(screen.getByRole('button', { name: /^취소/ }));
		await waitFor(() => expect(completed).toHaveBeenCalledOnce());
		expect(cancelled).not.toHaveBeenCalled();
	});
});
