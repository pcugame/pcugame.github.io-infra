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

	it('rejects game files larger than the hard 5GB browser limit', () => {
		const { result } = renderHook(() => useSubmissionFiles({ limits }));
		const game = file('game.zip', 'application/zip', 5 * 1024 * 1024 * 1024 + 1);
		const event = eventWithFiles([game]);

		act(() => result.current.handleGameChange(event));

		expect(result.current.gameFile).toBeNull();
		expect(result.current.fileSizeError).toContain('게임 파일');
		expect((event.target as HTMLInputElement).value).toBe('');
	});
});
