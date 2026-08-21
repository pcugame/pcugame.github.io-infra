/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DirectVideoUploadWidget from '../components/DirectVideoUploadWidget';

const { uploadDirectAssetFile, waitForDirectAssetReady, getDirectAssetUploadStatus } = vi.hoisted(() => ({
	uploadDirectAssetFile: vi.fn(),
	waitForDirectAssetReady: vi.fn(),
	getDirectAssetUploadStatus: vi.fn(),
}));

vi.mock('../lib/api/game-upload', () => ({
	uploadDirectAssetFile,
	waitForDirectAssetReady,
	getDirectAssetUploadStatus,
	cancelDirectAssetUploadSession: vi.fn(),
}));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	window.sessionStorage.clear();
});

describe('DirectVideoUploadWidget', () => {
	it('uploads multiple selected VIDEO files sequentially through canonical direct sessions', async () => {
		uploadDirectAssetFile
			.mockResolvedValueOnce({ status: 'VERIFYING', sessionId: 'video-1', generation: 1, sizeBytes: 1 })
			.mockResolvedValueOnce({ status: 'VERIFYING', sessionId: 'video-2', generation: 1, sizeBytes: 1 });
		waitForDirectAssetReady.mockResolvedValue({ state: 'READY' });
		getDirectAssetUploadStatus.mockResolvedValue({ state: 'READY' });
		const done = vi.fn();
		const first = new File(['a'], 'first.mp4', { type: 'video/mp4' });
		const second = new File(['b'], 'second.webm', { type: 'video/webm' });
		render(
			<QueryClientProvider client={new QueryClient()}>
				<DirectVideoUploadWidget projectId={77} initialFiles={[first, second]} autoStart onComplete={done} />
			</QueryClientProvider>,
		);

		await waitFor(() => expect(done).toHaveBeenCalledOnce());
		expect(uploadDirectAssetFile.mock.calls.map((call) => [call[0], call[1].name, call[2]])).toEqual([
			[77, 'first.mp4', 'VIDEO'],
			[77, 'second.webm', 'VIDEO'],
		]);
		expect(waitForDirectAssetReady).toHaveBeenNthCalledWith(1, 'video-1');
		expect(waitForDirectAssetReady).toHaveBeenNthCalledWith(2, 'video-2');
	});
});
