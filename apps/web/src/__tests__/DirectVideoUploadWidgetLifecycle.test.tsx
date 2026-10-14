/* @vitest-environment jsdom */
import { createFileSourceIdentity } from '../lib/file-identity';
import { setupFileIdentityEnvironment } from './helpers/file-identity';
setupFileIdentityEnvironment();
import { resetDirectUploadTasksForTests } from '../lib/upload/directUploadTask';
afterEach(resetDirectUploadTasksForTests);

import type { DirectGameUploadCompletionResponse } from '../contracts';
import { StrictMode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DirectVideoUploadWidget from '../components/DirectVideoUploadWidget';
import type { DirectAssetUploadSession, uploadDirectAssetFile } from '../lib/api/game-upload';

const api = vi.hoisted(() => ({ upload: vi.fn(), status: vi.fn(), ready: vi.fn(), cancel: vi.fn() }));
vi.mock('../lib/api/game-upload', () => ({
	uploadDirectAssetFile: api.upload, getDirectAssetUploadStatus: api.status,
	waitForDirectAssetReady: api.ready, cancelDirectAssetUploadSession: api.cancel,
}));
type Options = NonNullable<Parameters<typeof uploadDirectAssetFile>[4]>;
const file = new File(['video'], 'clip.mp4', { type: 'video/mp4' });
const storageKey = 'pcu.direct-video-upload:77';
const session: DirectAssetUploadSession = {
	sessionId: 'video-session', generation: 1, kind: 'VIDEO', owner: { type: 'PROJECT', id: 77 },
	partSizeBytes: 16, totalParts: 1, expiresAt: '2026-12-01T00:00:00Z',
	sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'a'.repeat(64),
};
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
async function save() {
	window.sessionStorage.setItem(storageKey, JSON.stringify({ session: { ...session, ...await createFileSourceIdentity(file) }, originalName: file.name, totalBytes: file.size, completed: 0 }));
}
function mount(onComplete = vi.fn(), onCancelled = vi.fn()) {
	const client = new QueryClient();
	const view = (complete: () => void) => <StrictMode><QueryClientProvider client={client}>
		<DirectVideoUploadWidget projectId={77} initialFiles={[file]} autoStart onComplete={complete} onCancelled={onCancelled} />
	</QueryClientProvider></StrictMode>;
	const result = render(view(onComplete));
	return { ...result, changeCallback: (complete: () => void) => result.rerender(view(complete)) };
}
afterEach(() => { cleanup(); vi.resetAllMocks(); window.sessionStorage.clear(); });

describe('video shared session lifetime', () => {
	it('waits for a late create and one DELETE before notifying cancellation', async () => {
		const upload = deferred<DirectGameUploadCompletionResponse>();
		const deletion = deferred<void>();
		let options!: Options;
		api.upload.mockImplementation((_owner, _file, _kind, _progress, next) => { options = next; return upload.promise; });
		api.cancel.mockReturnValue(deletion.promise);
		const completed = vi.fn();
		const cancelled = vi.fn();
		mount(completed, cancelled);
		fireEvent.click(await screen.findByRole('button', { name: '취소' }));
		fireEvent.click(screen.getByRole('button', { name: '동영상 업로드 시작' }));
		expect(options.signal?.aborted).toBe(true);
		expect(api.upload).toHaveBeenCalledOnce();
		expect(cancelled).not.toHaveBeenCalled();
		await act(async () => { options.onSession?.(session); upload.resolve({ ...session, status: 'READY', sizeBytes: file.size } satisfies DirectGameUploadCompletionResponse); });
		expect(api.cancel).toHaveBeenCalledExactlyOnceWith(session.sessionId);
		expect(cancelled).not.toHaveBeenCalled();
		expect(completed).not.toHaveBeenCalled();
		await act(async () => { deletion.resolve(); options.onSession?.(session); });
		expect(cancelled).toHaveBeenCalledOnce();
		expect(api.cancel).toHaveBeenCalledOnce();
		expect(api.ready).not.toHaveBeenCalled();
		expect(window.sessionStorage.getItem(storageKey)).toBeNull();
	});

	it.each(['READY', 'VERIFYING'] as const)('settles late cancellation against %s with no duplicate polling or completion', async state => {
		const upload = deferred<DirectGameUploadCompletionResponse>();
		let options!: Options;
		api.upload.mockImplementation((_owner, _file, _kind, _progress, next) => { options = next; return upload.promise; });
		api.cancel.mockRejectedValue(new Error('already completing'));
		api.status.mockResolvedValue({ ...session, state });
		api.ready.mockResolvedValue({ ...session, state: 'READY' });
		const completed = vi.fn();
		const cancelled = vi.fn();
		const view = mount(completed, cancelled);
		fireEvent.click(await screen.findByRole('button', { name: '취소' }));
		await act(async () => { options.onSession?.(session); });
		await waitFor(() => expect(completed).toHaveBeenCalledOnce());
		const nextComplete = vi.fn();
		view.changeCallback(nextComplete);
		await act(async () => { upload.resolve({ ...session, status: 'READY', sizeBytes: file.size } satisfies DirectGameUploadCompletionResponse); });
		expect(api.cancel).toHaveBeenCalledOnce();
		expect(api.ready).toHaveBeenCalledTimes(state === 'READY' ? 0 : 1);
		expect(completed).toHaveBeenCalledOnce();
		expect(nextComplete).not.toHaveBeenCalled();
		expect(cancelled).not.toHaveBeenCalled();
	});

	it('keeps one restored poll across new file-array and callback references, then completes once', async () => {
		await save();
		const ready = deferred<unknown>();
		api.status.mockResolvedValue({ ...session, state: 'VERIFYING' });
		api.ready.mockReturnValue(ready.promise);
		const completed = vi.fn();
		const latest = vi.fn();
		const view = mount(completed);
		await waitFor(() => expect(api.ready).toHaveBeenCalledOnce());
		view.changeCallback(latest);
		expect(api.ready).toHaveBeenCalledOnce();
		expect(api.ready.mock.calls[0][1].signal.aborted).toBe(false);
		await act(async () => { ready.resolve({ ...session, state: 'READY' }); });
		await waitFor(() => expect(latest).toHaveBeenCalledOnce());
		expect(completed).not.toHaveBeenCalled();
		expect(api.upload).not.toHaveBeenCalled();
	});

	it('aborts restored polling on unmount and preserves recovery state after late readiness', async () => {
		await save();
		const ready = deferred<unknown>();
		api.status.mockResolvedValue({ ...session, state: 'VERIFYING' });
		api.ready.mockReturnValue(ready.promise);
		const completed = vi.fn();
		const view = mount(completed);
		await waitFor(() => expect(api.ready).toHaveBeenCalledOnce());
		view.unmount();
		expect(api.ready.mock.calls[0][1].signal.aborted).toBe(true);
		await act(async () => { ready.resolve({ ...session, state: 'READY' }); });
		expect(completed).not.toHaveBeenCalled();
		expect(api.cancel).not.toHaveBeenCalled();
		expect(window.sessionStorage.getItem(storageKey)).toContain(session.sessionId);
	});

	it('blocks another create while a paused create is unresolved and hands its late session to the view', async () => {
		const old = deferred<DirectGameUploadCompletionResponse>();
		let oldOptions!: Options;
		api.upload.mockImplementationOnce((_owner, _file, _kind, _progress, options) => { oldOptions = options; return old.promise; });
		api.status.mockResolvedValue({ ...session, state: 'UPLOADING', originalName: file.name, totalBytes: file.size });
		mount();
		fireEvent.click(await screen.findByRole('button', { name: '일시 정지' }));
		fireEvent.click(screen.getByRole('button', { name: '동영상 업로드 시작' }));
		await act(async () => { oldOptions.onSession?.(session); old.reject(new Error('old failure')); });
		expect(api.upload).toHaveBeenCalledOnce();
		expect(window.sessionStorage.getItem(storageKey)).toContain(session.sessionId);
		expect(screen.queryByRole('alert')).toBeNull();
	});
});
