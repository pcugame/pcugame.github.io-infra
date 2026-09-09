/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminProjectDetail, SetProjectVideoOrderRequest } from '@pcu/contracts';

import { AdminProjectAssetManager } from '../features/admin/projects/AdminProjectAssetManager';

const project: AdminProjectDetail = {
	id: 7, title: 'Video project', slug: 'video-project', year: 2026, platforms: [],
	isIncomplete: false, video: null,
	videos: [
		{ assetId: 11, sortOrder: 0, role: 'MAIN', mimeType: 'video/mp4' },
		{ assetId: 12, sortOrder: 1, role: 'ADDITIONAL', mimeType: 'video/mp4' },
	],
	status: 'PUBLISHED', sortOrder: 0, members: [],
	assets: [
		{ id: 11, kind: 'VIDEO', url: 'https://api.test/assets/11', originalName: 'main.mp4', size: 1024, videoSortOrder: 0 },
		{ id: 12, kind: 'VIDEO', url: 'https://api.test/assets/12', originalName: 'additional.mp4', size: 1024, videoSortOrder: 1 },
	],
};

function renderManager(value: AdminProjectDetail, onReorderVideos: (body: SetProjectVideoOrderRequest) => void) {
	return render(
		<QueryClientProvider client={new QueryClient()}><MemoryRouter>
			<AdminProjectAssetManager project={value} projectId={value.id} canEditContent
				limits={{ imageMaxMb: 1, imagePdfMaxMb: 1, posterMaxMb: 1, posterPdfMaxMb: 1, videoMaxMb: 1, gameMaxMb: 1, requestMaxMb: 1, maxFiles: 1 }}
			isSettingPoster={false} isRemovingAsset={false} isRemovingWebgl={false}
			onSetPoster={vi.fn()} onRemoveAsset={vi.fn()} onRemoveWebgl={vi.fn()} onReorderVideos={onReorderVideos} />
		</MemoryRouter></QueryClientProvider>,
	);
}

describe('AdminProjectAssetManager video order', () => {
	afterEach(cleanup);
	it('sends the displayed asset order as expectedOrder when promoting a video', () => {
		const onReorderVideos = vi.fn();
		renderManager(project, onReorderVideos);
		expect(screen.getByText('메인 영상')).toBeTruthy();
		expect(screen.getByText('추가 영상 1')).toBeTruthy();
		fireEvent.click(screen.getAllByRole('button', { name: '메인으로 지정' })[1]!);
		expect(onReorderVideos).toHaveBeenCalledWith({ expectedOrder: [11, 12], order: [12, 11] });
	});

	it('hides reorder controls when the old API omits video order metadata', () => {
		const oldProject = { ...project, assets: project.assets.map((asset) => {
			const copy = { ...asset };
			if ('videoSortOrder' in copy) delete copy.videoSortOrder;
			return copy;
		}) };
		renderManager(oldProject, vi.fn());
		expect(screen.queryByRole('button', { name: '메인으로 지정' })).toBeNull();
		expect(screen.queryByRole('button', { name: '위로' })).toBeNull();
		expect(screen.getAllByRole('button', { name: '삭제' })).toHaveLength(2);
	});

	it('uses server order for NULL videos and allows first NULL to be designated main', () => {
		const onReorderVideos = vi.fn();
		const legacy = {
			...project,
			videos: [...project.videos].reverse().map((video, index) => ({ ...video, sortOrder: null, role: index === 0 ? 'MAIN' as const : 'ADDITIONAL' as const })),
			assets: project.assets.map((asset) => ({ ...asset, videoSortOrder: null })),
		};
		renderManager(legacy, onReorderVideos);
		expect(screen.getAllByText('순서 미지정')).toHaveLength(2);
		const buttons = screen.getAllByRole('button', { name: '메인으로 지정' });
		fireEvent.click(buttons[0]!);
		expect(onReorderVideos).toHaveBeenLastCalledWith({ expectedOrder: [12, 11], order: [12, 11] });
		fireEvent.click(buttons[1]!);
		expect(onReorderVideos).toHaveBeenLastCalledWith({ expectedOrder: [12, 11], order: [11, 12] });
	});
});
