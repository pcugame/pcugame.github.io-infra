/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({
	getStatus: vi.fn(),
	waitReady: vi.fn(),
	upload: vi.fn(),
	cancel: vi.fn(),
}));

vi.mock('../lib/api/game-upload', () => ({
	getDirectAssetUploadStatus: controls.getStatus,
	waitForDirectAssetReady: controls.waitReady,
	uploadDirectAssetFile: controls.upload,
	cancelDirectAssetUploadSession: controls.cancel,
}));

import GameUploadWidget from '../components/GameUploadWidget';

describe('GAME/WebGL direct upload reload recovery', () => {
	afterEach(() => {
		window.sessionStorage.clear();
		vi.clearAllMocks();
	});

	it('keeps a COMPLETING WebGL session and resumes background status polling after reload', async () => {
		const saved = {
			sessionId: 'webgl-long', owner: { type: 'PROJECT', id: 7 }, generation: 1,
			partSizeBytes: 16 * 1024 * 1024, totalParts: 320,
			expiresAt: '2026-08-22T00:00:00.000Z', sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1',
			sourceIdentity: 'a'.repeat(64), kind: 'WEBGL',
		};
		window.sessionStorage.setItem('pcu.direct-asset-upload:7:WEBGL', JSON.stringify(saved));
		controls.getStatus.mockResolvedValue({ ...saved, state: 'COMPLETING', originalName: 'webgl.zip', totalBytes: 5, parts: [] });
		controls.waitReady.mockResolvedValue({ ...saved, state: 'READY', originalName: 'webgl.zip', totalBytes: 5, parts: [] });
		const onComplete = vi.fn();
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

		render(
			<QueryClientProvider client={queryClient}>
				<GameUploadWidget projectId={7} uploadKind="WEBGL" onComplete={onComplete} />
			</QueryClientProvider>,
		);

		expect(await screen.findByText('업로드 완료')).toBeTruthy();
		expect(controls.waitReady).toHaveBeenCalledWith('webgl-long', {
			signal: expect.any(AbortSignal),
		});
		expect(window.sessionStorage.getItem('pcu.direct-asset-upload:7:WEBGL')).toBeNull();
		expect(onComplete).toHaveBeenCalledOnce();
		queryClient.clear();
	});
});
