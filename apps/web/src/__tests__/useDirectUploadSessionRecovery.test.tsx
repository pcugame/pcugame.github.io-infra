/* @vitest-environment jsdom */
import { useEffect } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DirectGameUploadCompletionResponse } from '../contracts';
import type { DirectAssetUploadSession, uploadDirectAssetFile } from '../lib/api/game-upload';
import { useDirectUploadSession } from '../lib/upload/useDirectUploadSession';

const api = vi.hoisted(() => ({ upload: vi.fn(), cancel: vi.fn(), status: vi.fn() }));
vi.mock('../lib/api/game-upload', () => ({
	uploadDirectAssetFile: api.upload, cancelDirectAssetUploadSession: api.cancel, getDirectAssetUploadStatus: api.status,
}));
type Options = NonNullable<Parameters<typeof uploadDirectAssetFile>[4]>;
const storageKey = 'recovery-test';
const file = new File(['data'], 'file');
const session: DirectAssetUploadSession = {
	sessionId: 'A', generation: 1, owner: { type: 'PROJECT', id: 77 }, kind: 'VIDEO',
	partSizeBytes: 16, totalParts: 1, expiresAt: '2026-12-01T00:00:00Z',
	sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'a'.repeat(64),
};
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
function mount() {
	const callbacks = { onCancelled: vi.fn(), onCancelReady: vi.fn(), onCancelError: vi.fn(), onCancelSettled: vi.fn() };
	const hook = renderHook(() => {
		const state = useDirectUploadSession<DirectAssetUploadSession>({ storageKey, ...callbacks });
		const { remember } = state;
		useEffect(() => {
			const raw = sessionStorage.getItem(storageKey);
			if (raw) remember(JSON.parse(raw));
		}, [remember]);
		return state;
	});
	return { ...hook, callbacks };
}
afterEach(() => { cleanup(); sessionStorage.clear(); vi.resetAllMocks(); });

describe('recovery ownership across real hook mounts', () => {
	it.each((['mount only', 'pending replacement', 'owned replacement', 'completed', 'cancelled', 'cleared', 'discarded while empty'] as const)
		.flatMap(action => [false, true].map(unmountBeforeResponse => ({ action, unmountBeforeResponse }))))(
		'handles an uncancelled late create after B: $action (B unmounted: $unmountBeforeResponse)', async ({ action, unmountBeforeResponse }) => {
			const upload = deferred<DirectGameUploadCompletionResponse>();
			const replacement = deferred<DirectGameUploadCompletionResponse>();
			const options: Options[] = [];
			api.upload.mockImplementation((_owner, _file, _kind, _progress, next: Options) => {
				options.push(next);
				return options.length === 1 ? upload.promise : replacement.promise;
			});
			api.cancel.mockResolvedValue(undefined);
			const a = mount();
			let transfer!: Promise<DirectGameUploadCompletionResponse>;
			act(() => {
				const run = a.result.current.beginRun()!;
				transfer = a.result.current.transfer(run, [77, file, 'VIDEO'], value => value);
			});
			a.unmount();
			const b = mount();
			const newer = { ...session, sessionId: 'B' };
			let nextTransfer: Promise<DirectGameUploadCompletionResponse> | undefined;
			if (action !== 'mount only' && action !== 'discarded while empty') {
				act(() => {
					const run = b.result.current.beginRun()!;
					nextTransfer = b.result.current.transfer(run, [77, file, 'VIDEO'], value => value);
					if (action !== 'pending replacement') options[1].onSession?.(newer);
					if (action === 'completed') expect(b.result.current.acceptReady(run, 'B', 1)).toBe(true);
					if (action === 'cleared') expect(b.result.current.forget('B')).toBe(true);
				});
			}
			if (action === 'cancelled' || action === 'discarded while empty') {
				await act(async () => { await b.result.current.cancel(); });
			}
			const stored = sessionStorage.getItem(storageKey);
			const ui = b.result.current.saved;
			if (unmountBeforeResponse) b.unmount();
			await act(async () => {
				options[0].onSession?.(session);
				upload.resolve({ status: 'READY', sessionId: 'A', generation: 1, sizeBytes: file.size });
				await transfer;
			});
			expect(sessionStorage.getItem(storageKey)).toBe(action === 'mount only' ? JSON.stringify(session) : stored);
			expect(b.result.current.saved).toEqual(ui);
			for (const callback of Object.values(a.callbacks)) expect(callback).not.toHaveBeenCalled();
			expect(api.cancel.mock.calls).toEqual(action === 'cancelled' ? [['B']] : []);
			if (!unmountBeforeResponse) b.unmount();
			expect(mount().result.current.saved).toEqual(action === 'mount only' ? session : action === 'owned replacement' ? newer : null);
			await act(async () => {
				replacement.resolve({ status: 'READY', sessionId: 'B', generation: 1, sizeBytes: file.size });
				await nextTransfer;
			});
		},
	);

	it.each([
		['late create', false, false], ['late create', true, false],
		['late DELETE', false, false], ['late DELETE', true, false],
		['late create', false, true], ['late create', true, true],
	] as const)('preserves B recovery ownership after A %s (DELETE fails: %s, B cleared: %s)', async (timing, fails, cleared) => {
		const upload = deferred<DirectGameUploadCompletionResponse>();
		const deletion = deferred<void>();
		let options!: Options;
		api.upload.mockImplementation((_owner, _file, _kind, _progress, next: Options) => { options = next; return upload.promise; });
		api.cancel.mockReturnValue(deletion.promise);
		api.status.mockRejectedValue(new Error('offline'));
		const a = mount();
		let transfer!: Promise<DirectGameUploadCompletionResponse>;
		act(() => {
			const run = a.result.current.beginRun()!;
			transfer = a.result.current.transfer(run, [77, file, 'VIDEO'], value => value);
		});
		if (timing === 'late DELETE') act(() => options.onSession?.(session));
		let cancellation!: Promise<void>;
		act(() => { cancellation = a.result.current.cancel(); });
		a.unmount();
		const b = mount();
		const newer = { ...session, sessionId: 'B' };
		act(() => b.result.current.remember(newer));
		if (cleared) {
			act(() => { b.result.current.forget(newer.sessionId); });
			b.unmount();
		}
		const stored = sessionStorage.getItem(storageKey);
		if (timing === 'late create') act(() => options.onSession?.(session));
		expect(api.cancel).toHaveBeenCalledExactlyOnceWith('A');
		expect(sessionStorage.getItem(storageKey)).toBe(stored);
		await act(async () => {
			if (fails) deletion.reject(new Error('DELETE failed')); else deletion.resolve();
			upload.resolve({ status: 'READY', sessionId: 'A', generation: 1, sizeBytes: file.size });
			await transfer;
			await cancellation;
		});
		if (!cleared) expect(b.result.current.saved).toEqual(newer);
		expect(sessionStorage.getItem(storageKey)).toBe(stored);
		for (const callback of [...Object.values(a.callbacks), ...Object.values(b.callbacks)]) expect(callback).not.toHaveBeenCalled();
		if (!cleared) b.unmount();
		const restored = mount();
		expect(restored.result.current.saved).toEqual(cleared ? null : newer);
	});

	it.each([false, true])('retains an unowned late create for recovery (cancel requested: %s)', async cancel => {
		const upload = deferred<DirectGameUploadCompletionResponse>();
		let options!: Options;
		api.upload.mockImplementation((_owner, _file, _kind, _progress, next: Options) => { options = next; return upload.promise; });
		api.cancel.mockRejectedValue(new Error('offline'));
		api.status.mockRejectedValue(new Error('offline'));
		const a = mount();
		let transfer!: Promise<DirectGameUploadCompletionResponse>;
		act(() => {
			const run = a.result.current.beginRun()!;
			transfer = a.result.current.transfer(run, [77, file, 'VIDEO'], value => value);
		});
		if (cancel) await act(async () => { await a.result.current.cancel(); });
		a.unmount();
		await act(async () => {
			options.onSession?.(session);
			upload.resolve({ status: 'READY', sessionId: 'A', generation: 1, sizeBytes: file.size });
			await transfer;
		});
		expect(api.cancel).toHaveBeenCalledTimes(cancel ? 1 : 0);
		expect(mount().result.current.saved).toEqual(session);
		for (const callback of Object.values(a.callbacks)) expect(callback).not.toHaveBeenCalled();
	});
});
