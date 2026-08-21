/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DirectImageUploadWidget from '../components/DirectImageUploadWidget';
import { YearMobileCard } from '../features/admin/exhibitions/ExhibitionRows';

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

describe('DirectImageUploadWidget', () => {
	it('uses an exhibition-owned POSTER direct multipart session and waits for worker readiness', async () => {
		uploadDirectAssetFile.mockResolvedValue({ status: 'VERIFYING', sessionId: 'poster-1', generation: 1, sizeBytes: 1 });
		waitForDirectAssetReady.mockResolvedValue({ state: 'READY' });
		const complete = vi.fn();
		const { container } = render(
			<QueryClientProvider client={new QueryClient()}>
				<DirectImageUploadWidget owner={{ type: 'EXHIBITION', id: 44 }} kind="POSTER" onComplete={complete} />
			</QueryClientProvider>,
		);

		const file = new File(['poster'], 'poster.webp', { type: 'image/webp' });
		const input = container.querySelector('input[type="file"]');
		expect(input).not.toBeNull();
		fireEvent.change(input!, { target: { files: [file] } });
		fireEvent.click(screen.getByRole('button', { name: '포스터 업로드 시작' }));

		await waitFor(() => expect(complete).toHaveBeenCalledOnce());
		expect(uploadDirectAssetFile).toHaveBeenCalledWith(
			{ type: 'EXHIBITION', id: 44 }, file, 'POSTER', expect.any(Function), expect.any(Object),
		);
		expect(waitForDirectAssetReady).toHaveBeenCalledWith('poster-1');
	});

	it('wires exhibition poster management to the direct widget rather than the legacy FormData route', async () => {
		uploadDirectAssetFile.mockResolvedValue({ status: 'VERIFYING', sessionId: 'poster-2', generation: 1, sizeBytes: 1 });
		waitForDirectAssetReady.mockResolvedValue({ state: 'READY' });
		const { container } = render(
			<QueryClientProvider client={new QueryClient()}>
				<YearMobileCard
					year={{ id: 45, year: 2026, title: 'Direct poster', isUploadEnabled: true, sortOrder: 0, projectCount: 0 }}
					isEditing={false}
					onEdit={vi.fn()} onCancel={vi.fn()} onSaved={vi.fn()} onDelete={vi.fn()} isDeleting={false}
					isAdmin={false} onExport={vi.fn()} isExporting={false} isAnyExporting={false}
				/>
			</QueryClientProvider>,
		);

		const file = new File(['poster'], 'direct-poster.webp', { type: 'image/webp' });
		fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
		fireEvent.click(screen.getByRole('button', { name: '포스터 업로드 시작' }));
		await waitFor(() => expect(uploadDirectAssetFile).toHaveBeenCalled());
		expect(uploadDirectAssetFile.mock.calls[0]?.slice(0, 3)).toEqual([
			{ type: 'EXHIBITION', id: 45 }, file, 'POSTER',
		]);
	});
});
