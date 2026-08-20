/* @vitest-environment jsdom */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSubmissionFiles } from '../features/project-submission/useSubmissionFiles';
import type { ClientUploadLimits } from '../lib/upload-limits';

const limits: ClientUploadLimits = {
	imageMaxMb: 10,
	imagePdfMaxMb: 16,
	posterMaxMb: 5,
	posterPdfMaxMb: 16,
	gameMaxMb: 5120,
	requestMaxMb: 16,
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

	it('does not expose a generic VIDEO selection path', () => {
		const { result } = renderHook(() => useSubmissionFiles({ limits }));
		expect('handleVideoChange' in result.current).toBe(false);
		expect('videoFiles' in result.current).toBe(false);
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
});
