/* @vitest-environment jsdom */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSubmissionFiles } from '../features/project-submission/useSubmissionFiles';
import type { ClientUploadLimits } from '../lib/upload-limits';

const limits: ClientUploadLimits = {
	imageMaxMb: 10,
	imagePdfMaxMb: 100,
	posterMaxMb: 5,
	posterPdfMaxMb: 25,
	videoMaxMb: 100,
	gameMaxMb: 5120,
	requestMaxMb: 250,
	maxFiles: 10,
};

function file(name: string, type: string, size: number) {
	const f = new File(['x'], name, { type });
	Object.defineProperty(f, 'size', { value: size });
	return f;
}

function eventWithFiles(files: File[]) {
	return {
		target: {
			files,
			value: 'selected',
		},
	} as unknown as React.ChangeEvent<HTMLInputElement>;
}

describe('useSubmissionFiles', () => {
	beforeEach(() => {
		vi.stubGlobal('URL', {
			createObjectURL: vi.fn(() => 'blob:poster'),
			revokeObjectURL: vi.fn(),
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('creates and revokes poster preview URLs for non-PDF posters', () => {
		const { result, unmount } = renderHook(() => useSubmissionFiles({ limits }));
		const poster = file('poster.png', 'image/png', 1024);

		act(() => result.current.handlePosterChange(eventWithFiles([poster])));
		expect(result.current.posterFile).toBe(poster);
		expect(result.current.posterPreview).toBe('blob:poster');

		act(() => result.current.clearPoster());
		expect(result.current.posterFile).toBeNull();
		expect(result.current.posterPreview).toBeNull();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:poster');

		unmount();
	});

	it('rejects oversized image files and clears the selection', () => {
		const { result } = renderHook(() => useSubmissionFiles({ limits }));
		const oversized = file('large.jpg', 'image/jpeg', 11 * 1024 * 1024);
		const event = eventWithFiles([oversized]);

		act(() => result.current.handleImagesChange(event));

		expect(result.current.imageFiles).toEqual([]);
		expect(result.current.fileSizeError).toContain('이미지 "large.jpg"');
		expect((event.target as HTMLInputElement).value).toBe('');
	});

	it('appends valid video selections and clears the input value', () => {
		const { result } = renderHook(() => useSubmissionFiles({ limits }));
		const first = file('first.mp4', 'video/mp4', 1024);
		const second = file('second.mp4', 'video/mp4', 1024);
		const firstEvent = eventWithFiles([first]);
		const secondEvent = eventWithFiles([second]);

		act(() => result.current.handleVideoChange(firstEvent));
		act(() => result.current.handleVideoChange(secondEvent));

		expect(result.current.videoFiles).toEqual([first, second]);
		expect((firstEvent.target as HTMLInputElement).value).toBe('');
		expect((secondEvent.target as HTMLInputElement).value).toBe('');
	});

	it('rejects a selection that would exceed the five-video project limit', () => {
		const { result } = renderHook(() => useSubmissionFiles({ limits }));
		const selected = Array.from({ length: 6 }, (_, index) =>
			file(`video-${index}.mp4`, 'video/mp4', 1024),
		);
		const event = eventWithFiles(selected);

		act(() => result.current.handleVideoChange(event));

		expect(result.current.videoFiles).toEqual([]);
		expect(result.current.fileSizeError).toContain('최대 5개');
		expect((event.target as HTMLInputElement).value).toBe('');
	});

	it('rejects game files larger than the configured game upload limit', () => {
		const { result } = renderHook(() => useSubmissionFiles({ limits }));
		const game = file('game.zip', 'application/zip', 5 * 1024 * 1024 * 1024 + 1);
		const event = eventWithFiles([game]);

		act(() => result.current.handleGameChange(event));

		expect(result.current.gameFile).toBeNull();
		expect(result.current.fileSizeError).toContain('게임 파일');
		expect((event.target as HTMLInputElement).value).toBe('');
	});

	it('keeps GAME and WEBGL ZIP selections independently', () => {
		const { result } = renderHook(() => useSubmissionFiles({ limits }));
		const game = file('game.zip', 'application/zip', 1024);
		const webgl = file('webgl.zip', 'application/zip', 2048);

		act(() => result.current.handleGameChange(eventWithFiles([game])));
		act(() => result.current.handleWebglChange(eventWithFiles([webgl])));
		expect(result.current.gameFile).toBe(game);
		expect(result.current.webglFile).toBe(webgl);

		act(() => result.current.clearWebglFile());
		expect(result.current.webglFile).toBeNull();
		expect(result.current.gameFile).toBe(game);
	});

	it('enforces the shared document and attachment count', () => {
		const { result } = renderHook(() => useSubmissionFiles({
			limits,
			materialLimits: { maxCount: 2, maxBytes: 50 * 1024 * 1024 },
		}));
		const first = file('guide.pdf', 'application/pdf', 1024);
		const second = file('notes.txt', 'text/plain', 1024);
		const third = file('extra.bin', 'application/octet-stream', 1024);
		act(() => result.current.handleDocumentsChange(eventWithFiles([first])));
		act(() => result.current.handleAttachmentsChange(eventWithFiles([second])));
		act(() => result.current.handleAttachmentsChange(eventWithFiles([third])));
		expect(result.current.documentFiles).toEqual([first]);
		expect(result.current.attachmentFiles).toEqual([second]);
		expect(result.current.fileSizeError).toContain('최대 2개');
	});
});
