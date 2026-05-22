/* @vitest-environment jsdom */

import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadFormData } from '../lib/api/client';
import { UploadProvider } from '../lib/upload';
import {
	clearUpload,
	finishUpload,
	getUploadSnapshot,
	getVisibleUploadTask,
	startUpload,
} from '../lib/upload/store';

class MockXMLHttpRequest {
	static instances: MockXMLHttpRequest[] = [];

	upload: {
		onprogress: ((event: ProgressEvent) => void) | null;
		onload: (() => void) | null;
	} = {
		onprogress: null,
		onload: null,
	};
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onabort: (() => void) | null = null;
	status = 200;
	statusText = 'OK';
	responseText = '{"ok":true,"data":{"ok":true}}';
	withCredentials = false;

	constructor() {
		MockXMLHttpRequest.instances.push(this);
	}

	open = vi.fn();
	send = vi.fn();
}

function resetUploads() {
	for (const task of getUploadSnapshot()) {
		clearUpload(task.id);
	}
}

afterEach(() => {
	resetUploads();
	MockXMLHttpRequest.instances = [];
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('global upload manager', () => {
	it('tracks uploadFormData when FormData contains a file', async () => {
		vi.useFakeTimers();
		vi.stubEnv('VITE_MOCK', 'false');
		vi.stubGlobal('XMLHttpRequest', MockXMLHttpRequest);

		const fd = new FormData();
		fd.append('file', new File(['hello'], 'hello.txt', { type: 'text/plain' }));

		const request = uploadFormData<{ ok: boolean }>('/upload', fd, { title: '파일 업로드' });
		const xhr = MockXMLHttpRequest.instances[0];

		expect(getVisibleUploadTask()?.title).toBe('파일 업로드');

		xhr.upload.onprogress?.({
			lengthComputable: true,
			loaded: 50,
			total: 100,
		} as ProgressEvent);
		expect(getVisibleUploadTask()?.percent).toBe(50);

		xhr.upload.onload?.();
		expect(getVisibleUploadTask()?.phase).toBe('processing');

		xhr.onload?.();
		await expect(request).resolves.toEqual({ ok: true });
		expect(getVisibleUploadTask()).toBeNull();

		act(() => {
			vi.advanceTimersByTime(450);
		});
		expect(getUploadSnapshot()).toHaveLength(0);
	});

	it('does not show an upload task for FormData without files', async () => {
		vi.stubEnv('VITE_MOCK', 'false');
		vi.stubGlobal('XMLHttpRequest', MockXMLHttpRequest);

		const fd = new FormData();
		fd.append('payload', JSON.stringify({ title: 'no file' }));

		const request = uploadFormData<{ ok: boolean }>('/upload', fd, { title: 'JSON 요청' });
		const xhr = MockXMLHttpRequest.instances[0];

		expect(getUploadSnapshot()).toHaveLength(0);

		xhr.onload?.();
		await expect(request).resolves.toEqual({ ok: true });
		expect(getUploadSnapshot()).toHaveLength(0);
	});

	it('registers beforeunload while the overlay is open', () => {
		vi.useFakeTimers();
		const addSpy = vi.spyOn(window, 'addEventListener');
		const removeSpy = vi.spyOn(window, 'removeEventListener');

		render(
			<UploadProvider>
				<div />
			</UploadProvider>,
		);

		let id = '';
		act(() => {
			id = startUpload({ title: '파일 업로드' });
		});

		screen.getByRole('dialog', { name: '파일 업로드' });
		expect(addSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));

		act(() => {
			finishUpload(id);
			vi.advanceTimersByTime(450);
		});

		expect(removeSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));
	});
});
