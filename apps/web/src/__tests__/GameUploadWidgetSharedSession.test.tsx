/* @vitest-environment jsdom */
import { resetDirectUploadTasksForTests } from '../lib/upload/directUploadTask';
afterEach(resetDirectUploadTasksForTests);

import type { DirectGameUploadCompletionResponse } from '../contracts';
import { StrictMode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GameUploadWidget from '../components/GameUploadWidget';
import type { DirectAssetUploadSession, uploadDirectAssetFile } from '../lib/api/game-upload';

const api = vi.hoisted(() => ({ upload: vi.fn(), status: vi.fn(), ready: vi.fn(), cancel: vi.fn() }));
vi.mock('../lib/api/game-upload', () => ({
	uploadDirectAssetFile: api.upload, getDirectAssetUploadStatus: api.status,
	waitForDirectAssetReady: api.ready, cancelDirectAssetUploadSession: api.cancel,
}));
type Options = NonNullable<Parameters<typeof uploadDirectAssetFile>[4]>;
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(yes => { resolve = yes; });
	return { promise, resolve };
}
afterEach(() => { cleanup(); vi.resetAllMocks(); window.sessionStorage.clear(); });

describe.each(['GAME', 'WEBGL'] as const)('%s shared session ownership', kind => {
	const file = new File(['game'], 'build.zip', { type: 'application/zip' });
	const storageKey = `pcu.direct-asset-upload:7:${kind}`;
	const session: DirectAssetUploadSession = {
		sessionId: `source-${kind}`, generation: 1, kind, owner: { type: 'PROJECT', id: 7 },
		partSizeBytes: 16, totalParts: 1, expiresAt: '2026-12-01T00:00:00Z',
		sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'a'.repeat(64),
	};
	const status = (state: string) => ({ ...session, state, originalName: file.name, totalBytes: file.size, parts: [] });
	function mount(onComplete = vi.fn(), onCancelled = vi.fn()) {
		const client = new QueryClient();
		const view = (complete: () => void) => <StrictMode><QueryClientProvider client={client}>
			<GameUploadWidget projectId={7} uploadKind={kind} initialFile={file} autoStart onComplete={complete} onCancelled={onCancelled} />
		</QueryClientProvider></StrictMode>;
		const result = render(view(onComplete));
		return { ...result, changeCallback: (complete: () => void) => result.rerender(view(complete)) };
	}

	it('waits for late creation and DELETE, preserving the bare locator and suppressing late completion', async () => {
		const upload = deferred<DirectGameUploadCompletionResponse>();
		const deletion = deferred<void>();
		let options!: Options;
		api.upload.mockImplementation((_owner, _file, _kind, _progress, next) => { options = next; return upload.promise; });
		api.cancel.mockReturnValue(deletion.promise);
		const completed = vi.fn();
		const cancelled = vi.fn();
		mount(completed, cancelled);
		fireEvent.click(await screen.findByRole('button', { name: '취소 (세션 삭제)' }));
		expect(options.signal?.aborted).toBe(true);
		fireEvent.click(screen.getByRole('button', { name: '업로드 시작' }));
		expect(api.upload).toHaveBeenCalledOnce();
		expect(cancelled).not.toHaveBeenCalled();
		await act(async () => { options.onSession?.(session); upload.resolve({ ...session, status: 'READY', sizeBytes: file.size } satisfies DirectGameUploadCompletionResponse); });
		expect(JSON.parse(window.sessionStorage.getItem(storageKey)!)).toEqual(session);
		expect(api.cancel).toHaveBeenCalledExactlyOnceWith(session.sessionId);
		expect(cancelled).not.toHaveBeenCalled();
		await act(async () => { deletion.resolve(); options.onSession?.(session); });
		expect(cancelled).toHaveBeenCalledOnce();
		expect(completed).not.toHaveBeenCalled();
		expect(api.ready).not.toHaveBeenCalled();
		expect(window.sessionStorage.getItem(storageKey)).toBeNull();
	});

	it('retains a late create after unmount without deleting or notifying', async () => {
		const upload = deferred<DirectGameUploadCompletionResponse>();
		let options!: Options;
		api.upload.mockImplementation((_owner, _file, _kind, _progress, next) => { options = next; return upload.promise; });
		const completed = vi.fn();
		const view = mount(completed);
		await screen.findByRole('button', { name: '일시 정지' });
		view.unmount();
		await act(async () => { options.onSession?.(session); upload.resolve({ ...session, status: 'READY', sizeBytes: file.size } satisfies DirectGameUploadCompletionResponse); });
		expect(options.signal?.aborted).toBe(true);
		expect(JSON.parse(window.sessionStorage.getItem(storageKey)!)).toEqual(session);
		expect(api.cancel).not.toHaveBeenCalled();
		expect(completed).not.toHaveBeenCalled();
	});

	it.each(['REJECTED', 'EXPIRED'])('requires an explicit new upload after cancellation confirms %s', async state => {
		api.upload.mockImplementationOnce((_owner, _file, _kind, _progress, options: Options) => {
			options.onSession?.(session); return new Promise(() => undefined);
		}).mockImplementationOnce(async (_owner, _file, nextKind, _progress, options: Options) => {
			const replacement = { ...session, sessionId: 'replacement' };
			expect(nextKind).toBe(kind);
			expect(options.resume).toBeUndefined();
			options.onSession?.(replacement);
			return { ...replacement, status: 'READY', sizeBytes: file.size } satisfies DirectGameUploadCompletionResponse;
		});
		api.cancel.mockRejectedValue(new Error('cannot delete'));
		api.status.mockResolvedValue(status(state));
		const completed = vi.fn();
		const cancelled = vi.fn();
		mount(completed, cancelled);
		fireEvent.click(await screen.findByRole('button', { name: '취소 (세션 삭제)' }));
		const restart = await screen.findByRole('button', { name: '새 업로드 시작' });
		expect(api.upload).toHaveBeenCalledOnce();
		expect(window.sessionStorage.getItem(storageKey)).not.toBeNull();
		expect(cancelled).not.toHaveBeenCalled();
		fireEvent.click(restart);
		await waitFor(() => expect(completed).toHaveBeenCalledOnce());
		expect(api.upload).toHaveBeenCalledTimes(2);
	});

	it('keeps one restored COMPLETING poll across callback changes and reports completion once', async () => {
		window.sessionStorage.setItem(storageKey, JSON.stringify(session));
		const ready = deferred<unknown>();
		api.status.mockResolvedValue(status('COMPLETING'));
		api.ready.mockReturnValue(ready.promise);
		const completed = vi.fn();
		const latest = vi.fn();
		const view = mount(completed);
		await waitFor(() => expect(api.ready).toHaveBeenCalledOnce());
		view.changeCallback(latest);
		expect(api.ready.mock.calls[0][1].signal.aborted).toBe(false);
		await act(async () => { ready.resolve(status('READY')); });
		expect(api.ready).toHaveBeenCalledOnce();
		expect(latest).toHaveBeenCalledOnce();
		expect(completed).not.toHaveBeenCalled();
		expect(api.upload).not.toHaveBeenCalled();
	});

	it('does not auto-create after recovering CANCELLED', async () => {
		window.sessionStorage.setItem(storageKey, JSON.stringify(session));
		api.status.mockResolvedValue(status('CANCELLED'));
		const completed = vi.fn();
		mount(completed);
		await waitFor(() => expect(window.sessionStorage.getItem(storageKey)).toBeNull());
		await act(async () => { await Promise.resolve(); });
		expect(api.upload).not.toHaveBeenCalled();
		expect(completed).not.toHaveBeenCalled();
	});

	it('reports READY from cancellation once without polling or accepting a late upload completion', async () => {
		const upload = deferred<DirectGameUploadCompletionResponse>();
		api.upload.mockImplementation((_owner, _file, _kind, _progress, options: Options) => {
			options.onSession?.(session); return upload.promise;
		});
		api.cancel.mockRejectedValue(new Error('already completed'));
		api.status.mockResolvedValue(status('READY'));
		const completed = vi.fn();
		const cancelled = vi.fn();
		mount(completed, cancelled);
		fireEvent.click(await screen.findByRole('button', { name: '취소 (세션 삭제)' }));
		await waitFor(() => expect(completed).toHaveBeenCalledOnce());
		await act(async () => { upload.resolve({ ...session, status: 'READY', sizeBytes: file.size } satisfies DirectGameUploadCompletionResponse); });
		expect(completed).toHaveBeenCalledOnce();
		expect(cancelled).not.toHaveBeenCalled();
		expect(api.ready).not.toHaveBeenCalled();
	});
});
