/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
	AdminExhibitionItem,
	AdminProjectDetail,
	ResponsiveImage,
} from '@pcu/contracts';

import { YearMobileCard } from '../features/admin/exhibitions/ExhibitionRows';
import { AdminProjectAssetManager } from '../features/admin/projects/AdminProjectAssetManager';

const image: ResponsiveImage = {
	original: {
		url: 'https://images.test/admin-original.webp',
		width: 1200,
		height: 800,
	},
	renditions: [{
		profile: 'CARD_480',
		url: 'https://images.test/admin-card.webp',
		width: 480,
		height: 320,
	}],
};

afterEach(cleanup);

function withQueryClient(ui: React.ReactNode) {
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<MemoryRouter>{ui}</MemoryRouter>
		</QueryClientProvider>,
	);
}

describe('admin responsive image previews', () => {
	it('renders an exhibition poster through the shared responsive component', () => {
		const exhibition: AdminExhibitionItem = {
			id: 1,
			year: 2026,
			title: '졸업 전시',
			isUploadEnabled: true,
			sortOrder: 0,
			projectCount: 1,
			poster: image,
		};
		withQueryClient(
			<YearMobileCard
				year={exhibition}
				isEditing={false}
				onEdit={vi.fn()}
				onCancel={vi.fn()}
				onSaved={vi.fn()}
				onDelete={vi.fn()}
				isDeleting={false}
				isAdmin={false}
				onExport={vi.fn()}
				isExporting={false}
				isAnyExporting={false}
			/>,
		);

		const preview = screen.getByRole('img', { name: '졸업 전시 전시회 포스터' });
		expect(preview.getAttribute('srcset')).toContain(`${image.renditions[0]?.url} 480w`);
		expect(preview.getAttribute('sizes')).toBe('72px');
	});

	it('renders IMAGE and THUMBNAIL assets responsively without changing VIDEO URLs', () => {
		const project: AdminProjectDetail = {
			id: 1,
			title: 'Admin project',
			slug: 'admin-project',
			year: 2026,
			platforms: ['PC'],
			isIncomplete: false,
			video: null,
			videos: [],
			status: 'PUBLISHED',
			sortOrder: 0,
			members: [],
			assets: [
				{
					id: 10,
					kind: 'IMAGE',
					image,
					originalName: 'screenshot.webp',
					size: 100,
				},
				{
					id: 11,
					kind: 'THUMBNAIL',
					image,
					originalName: 'thumbnail.webp',
					size: 100,
				},
				{
					id: 12,
					kind: 'VIDEO',
					url: 'https://assets.test/protected/video.mp4',
					originalName: 'video.mp4',
					size: 100,
				},
			],
		};

		withQueryClient(
			<AdminProjectAssetManager
				project={project}
				projectId={project.id}
				limits={{
					imageMaxMb: 10,
					imagePdfMaxMb: 100,
					posterMaxMb: 10,
					posterPdfMaxMb: 50,
					gameMaxMb: 5120,
					videoMaxMb: 200,
					requestMaxMb: 250,
					maxFiles: 10,
				}}
				canEditContent={false}
				addAssetError={null}
				isAddingAsset={false}
				isSettingPoster={false}
				isRemovingAsset={false}
				isRemovingWebgl={false}
				onAddAsset={vi.fn()}
				onSetPoster={vi.fn()}
				onRemoveAsset={vi.fn()}
				onRemoveWebgl={vi.fn()}
			/>,
		);

		for (const name of ['screenshot.webp', 'thumbnail.webp']) {
			const preview = screen.getByRole('img', { name });
			expect(preview.getAttribute('srcset')).toContain(`${image.renditions[0]?.url} 480w`);
			expect(preview.getAttribute('sizes')).toBe('160px');
		}
		expect(screen.queryByRole('img', { name: 'video.mp4' })).toBeNull();
		expect(screen.getByText(/\[VIDEO\] video\.mp4/)).toBeTruthy();
	});

	it('uses the reusable direct VIDEO uploader for administrator multiple-video additions', () => {
		const project: AdminProjectDetail = {
			id: 2, title: 'Video project', slug: 'video-project', year: 2026,
			platforms: ['PC'], isIncomplete: false, video: null, videos: [],
			status: 'PUBLISHED', sortOrder: 0, members: [], assets: [],
		};
		const { container } = withQueryClient(
			<AdminProjectAssetManager
				project={project}
				projectId={project.id}
				limits={{ imageMaxMb: 10, imagePdfMaxMb: 100, posterMaxMb: 10, posterPdfMaxMb: 50, gameMaxMb: 5120, videoMaxMb: 200, requestMaxMb: 250, maxFiles: 10 }}
				canEditContent
				addAssetError={null}
				isAddingAsset={false}
				isSettingPoster={false}
				isRemovingAsset={false}
				isRemovingWebgl={false}
				onAddAsset={vi.fn()}
				onSetPoster={vi.fn()}
				onRemoveAsset={vi.fn()}
				onRemoveWebgl={vi.fn()}
			/>,
		);
		expect(screen.getByRole('heading', { name: '동영상 업로드' })).toBeTruthy();
		expect(container.querySelector('input[accept*="video/mp4"]')?.hasAttribute('multiple')).toBe(true);
	});

	it('displays and deletes the current immutable WebGL deployment', () => {
		const onRemoveWebgl = vi.fn();
		const deploymentId = '123e4567-e89b-42d3-a456-426614174000';
		const project: AdminProjectDetail = {
			id: 3, title: 'WebGL project', slug: 'webgl-project', year: 2026,
			platforms: ['WEB'], isIncomplete: false, video: null, videos: [],
			status: 'PUBLISHED', sortOrder: 0, members: [], assets: [],
			webglUrl: `https://assets.test/public/webgl/3/${deploymentId}/index.html`,
			webglDeployment: {
				id: deploymentId,
				url: `https://assets.test/public/webgl/3/${deploymentId}/index.html`,
				createdAt: '2026-08-21T00:00:00.000Z',
			},
		};
		withQueryClient(
			<AdminProjectAssetManager
				project={project}
				projectId={project.id}
				limits={{ imageMaxMb: 10, imagePdfMaxMb: 100, posterMaxMb: 10, posterPdfMaxMb: 50, gameMaxMb: 5120, videoMaxMb: 200, requestMaxMb: 250, maxFiles: 10 }}
				canEditContent
				addAssetError={null}
				isAddingAsset={false}
				isSettingPoster={false}
				isRemovingAsset={false}
				isRemovingWebgl={false}
				onAddAsset={vi.fn()}
				onSetPoster={vi.fn()}
				onRemoveAsset={vi.fn()}
				onRemoveWebgl={onRemoveWebgl}
			/>,
		);

		expect(screen.getByText(deploymentId)).toBeTruthy();
		expect(screen.getByRole('link', { name: '플레이 페이지 열기' }).getAttribute('href'))
			.toBe('/projects/3/play');
		fireEvent.click(screen.getByRole('button', { name: 'WebGL 빌드 삭제' }));
		expect(onRemoveWebgl).toHaveBeenCalledOnce();
	});
});
