/* @vitest-environment jsdom */
import type { DirectGameUploadCompletionResponse } from '../contracts';
import { StrictMode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DirectImageUploadWidget from '../components/DirectImageUploadWidget';
import type { DirectAssetUploadSession, uploadDirectAssetFile } from '../lib/api/game-upload';

const api = vi.hoisted(() => ({ upload: vi.fn(), status: vi.fn(), ready: vi.fn(), cancel: vi.fn() }));
vi.mock('../lib/api/game-upload', () => ({
	uploadDirectAssetFile: api.upload, getDirectAssetUploadStatus: api.status,
	waitForDirectAssetReady: api.ready, cancelDirectAssetUploadSession: api.cancel,
}));
type Options = NonNullable<Parameters<typeof uploadDirectAssetFile>[4]>;
const file = new File(['image'], 'cover.png', { type: 'image/png' });
const storageKey = 'pcu.direct-image-upload:PROJECT:4';
const session: DirectAssetUploadSession = {
	sessionId: 'image-session', generation: 1, kind: 'IMAGE', owner: { type: 'PROJECT', id: 4 },
	partSizeBytes: 16, totalParts: 1, expiresAt: '2026-12-01T00:00:00Z',
	sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'a'.repeat(64),
};
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
function save() {
	window.sessionStorage.setItem(storageKey, JSON.stringify({ session, originalName: file.name, totalBytes: file.size, completed: 0 }));
}
function mount(onComplete = vi.fn(), onCancelled = vi.fn()) {
	const client = new QueryClient();
	const view = (complete: () => void, ownerId = 4) => <StrictMode><QueryClientProvider client={client}>
		<DirectImageUploadWidget owner={{ type: 'PROJECT', id: ownerId }} kind="IMAGE" initialFiles={[file]}
			autoStart onComplete={complete} onCancelled={onCancelled} />
	</QueryClientProvider></StrictMode>;
	const result = render(view(onComplete));
	return { ...result, changeOwner: (id: number) => result.rerender(view(onComplete, id)), changeCallback: (complete: () => void) => result.rerender(view(complete)) };
}
afterEach(() => { cleanup(); vi.resetAllMocks(); window.sessionStorage.clear(); });

describe('image session ownership', () => {
	it('settles a late create and DELETE before cancellation notification, ignoring late progress and completion', async () => {
		const upload = deferred<DirectGameUploadCompletionResponse>();
		const deletion = deferred<void>();
		let options!: Options;
		let progress!: NonNullable<Parameters<typeof uploadDirectAssetFile>[3]>;
		api.upload.mockImplementation((_owner, _file, _kind, nextProgress, nextOptions) => {
			options = nextOptions; progress = nextProgress; return upload.promise;
		});
		api.cancel.mockReturnValue(deletion.promise);
		const completed = vi.fn();
		const cancelled = vi.fn();
		mount(completed, cancelled);
		fireEvent.click(await screen.findByRole('button', { name: '취소' }));
		expect(options.signal?.aborted).toBe(true);
		expect(cancelled).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: '이미지 업로드 시작' }));
		expect(api.upload).toHaveBeenCalledOnce();
		await act(async () => {
			options.onSession?.(session);
			progress({ percent: 100, uploadedBytes: 5, totalBytes: 5, uploadedChunks: 1, totalChunks: 1 });
			upload.resolve({ status: 'READY', sessionId: session.sessionId, generation: 1, sizeBytes: file.size } satisfies DirectGameUploadCompletionResponse);
		});
		expect(api.cancel).toHaveBeenCalledExactlyOnceWith(session.sessionId);
		expect(cancelled).not.toHaveBeenCalled();
		expect(completed).not.toHaveBeenCalled();
		expect(window.sessionStorage.getItem(storageKey)).toContain(session.sessionId);
		await act(async () => { deletion.resolve(); });
		expect(cancelled).toHaveBeenCalledOnce();
		expect(window.sessionStorage.getItem(storageKey)).toBeNull();
		await act(async () => { options.onSession?.(session); });
		expect(api.cancel).toHaveBeenCalledOnce();
		expect(window.sessionStorage.getItem(storageKey)).toBeNull();
	});

	it('reports restored readiness only once with autoStart and a replaced completion callback', async () => {
		save();
		api.status.mockResolvedValue({ ...session, state: 'READY' });
		const completed = vi.fn();
		const nextCompleted = vi.fn();
		const view = mount(completed);
		await waitFor(() => expect(completed).toHaveBeenCalledOnce());
		view.changeCallback(nextCompleted);
		await act(async () => { await Promise.resolve(); });
		expect(completed).toHaveBeenCalledOnce();
		expect(nextCompleted).not.toHaveBeenCalled();
		expect(api.upload).not.toHaveBeenCalled();
		expect(window.sessionStorage.getItem(storageKey)).toBeNull();
	});

	it('converges cancellation to READY once even when the aborted transfer later completes', async () => {
		const upload = deferred<DirectGameUploadCompletionResponse>();
		api.upload.mockImplementation((_owner, _file, _kind, _progress, options: Options) => {
			options.onSession?.(session); return upload.promise;
		});
		api.cancel.mockRejectedValue(new Error('already completing'));
		api.status.mockResolvedValue({ ...session, state: 'VERIFYING' });
		api.ready.mockResolvedValue({ ...session, state: 'READY' });
		const completed = vi.fn();
		const cancelled = vi.fn();
		mount(completed, cancelled);
		fireEvent.click(await screen.findByRole('button', { name: '일시 정지' }));
		fireEvent.click(screen.getByRole('button', { name: '취소' }));
		await waitFor(() => expect(completed).toHaveBeenCalledOnce());
		await act(async () => { upload.resolve({ status: 'READY', sessionId: session.sessionId, generation: 1, sizeBytes: file.size } satisfies DirectGameUploadCompletionResponse); });
		expect(completed).toHaveBeenCalledOnce();
		expect(cancelled).not.toHaveBeenCalled();
	});

	it('keeps a restored locator on lookup failure and resumes it on explicit retry', async () => {
		save();
		api.status.mockRejectedValue(new Error('offline'));
		const completed = vi.fn();
		mount(completed);
		await screen.findByRole('alert');
		expect(window.sessionStorage.getItem(storageKey)).toContain(session.sessionId);
		expect(api.upload).not.toHaveBeenCalled();
		api.status.mockResolvedValue({ ...session, state: 'UPLOADING' });
		api.upload.mockResolvedValue({ status: 'READY', sessionId: session.sessionId, generation: 1, sizeBytes: file.size } satisfies DirectGameUploadCompletionResponse);
		fireEvent.click(screen.getByRole('button', { name: '이어올리기' }));
		await waitFor(() => expect(completed).toHaveBeenCalledOnce());
		expect(api.upload.mock.calls[0][4].resume).toEqual(session);
	});

	it('aborts restored polling on unmount and ignores its late readiness', async () => {
		save();
		const ready = deferred<unknown>();
		api.status.mockResolvedValue({ ...session, state: 'VERIFYING' });
		api.ready.mockReturnValue(ready.promise);
		const completed = vi.fn();
		const view = mount(completed);
		await waitFor(() => expect(api.ready).toHaveBeenCalledOnce());
		const signal = api.ready.mock.calls[0][1].signal as AbortSignal;
		view.unmount();
		expect(signal.aborted).toBe(true);
		await act(async () => { ready.resolve({ ...session, state: 'READY' }); });
		expect(completed).not.toHaveBeenCalled();
		expect(api.cancel).not.toHaveBeenCalled();
		expect(window.sessionStorage.getItem(storageKey)).toContain(session.sessionId);
	});

	it('does not let a paused request overwrite a newer locator or report its late failure', async () => {
		const oldUpload = deferred<DirectGameUploadCompletionResponse>();
		let oldOptions!: Options;
		const newer = { ...session, sessionId: 'newer-image' };
		api.upload.mockImplementationOnce((_owner, _file, _kind, _progress, options: Options) => {
			oldOptions = options; return oldUpload.promise;
		}).mockImplementationOnce((_owner, _file, _kind, _progress, options: Options) => {
			options.onSession?.(newer); return new Promise(() => undefined);
		});
		mount();
		fireEvent.click(await screen.findByRole('button', { name: '일시 정지' }));
		fireEvent.click(screen.getByRole('button', { name: '이미지 업로드 시작' }));
		await act(async () => { oldOptions.onSession?.(session); oldUpload.reject(new Error('old failure')); });
		expect(window.sessionStorage.getItem(storageKey)).toContain(newer.sessionId);
		expect(screen.queryByRole('alert')).toBeNull();
		expect(screen.getByRole('button', { name: '일시 정지' })).toBeTruthy();
	});
	it('retries a failure before creation without losing the chosen file', async () => {
		api.upload.mockRejectedValueOnce(new Error('create failed'))
			.mockImplementationOnce(async (_owner, _file, _kind, _progress, options: Options) => {
				options.onSession?.(session);
				return { status: 'READY', sessionId: session.sessionId, generation: session.generation, sizeBytes: file.size } satisfies DirectGameUploadCompletionResponse;
			});
		const completed = vi.fn();
		mount(completed);
		fireEvent.click(await screen.findByRole('button', { name: '재시도' }));
		await waitFor(() => expect(completed).toHaveBeenCalledOnce());
		expect(api.upload).toHaveBeenCalledTimes(2);
		expect(api.upload.mock.calls[1][1]).toBe(file);
		expect(api.upload.mock.calls[1][4].resume).toBeUndefined();
	});

	it('isolates an owner change from the old pending create and its late completion', async () => {
		const old = deferred<DirectGameUploadCompletionResponse>();
		let oldOptions!: Options;
		const nextSession = { ...session, sessionId: 'other-owner', owner: { type: 'PROJECT', id: 5 } };
		api.upload.mockImplementationOnce((_owner, _file, _kind, _progress, options: Options) => {
			oldOptions = options; return old.promise;
		}).mockImplementationOnce((_owner, _file, _kind, _progress, options: Options) => {
			options.onSession?.(nextSession as DirectAssetUploadSession); return new Promise(() => undefined);
		});
		const completed = vi.fn();
		const view = mount(completed);
		await screen.findByRole('button', { name: '일시 정지' });
		view.changeOwner(5);
		await waitFor(() => expect(api.upload).toHaveBeenCalledTimes(2));
		expect(oldOptions.signal?.aborted).toBe(true);
		await act(async () => { oldOptions.onSession?.(session); old.resolve({ status: 'READY', ...session, sizeBytes: file.size } satisfies DirectGameUploadCompletionResponse); });
		expect(window.sessionStorage.getItem('pcu.direct-image-upload:PROJECT:5')).toContain('other-owner');
		expect(window.sessionStorage.getItem(storageKey)).toContain(session.sessionId);
		expect(completed).not.toHaveBeenCalled();
		expect(api.cancel).not.toHaveBeenCalled();
	});

});
