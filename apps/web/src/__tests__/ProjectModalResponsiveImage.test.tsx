/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublicProjectDetailResponse, ResponsiveImage } from '@pcu/contracts';

const mocks = vi.hoisted(() => ({
	getProjectDetail: vi.fn(),
}));

vi.mock('../lib/api', () => ({
	publicApi: {
		getProjectDetail: mocks.getProjectDetail,
	},
}));

import { ProjectModal } from '../components/project/ProjectModal';

const poster: ResponsiveImage = {
	original: {
		url: 'https://images.test/poster-original.webp',
		width: 1600,
		height: 2240,
	},
	renditions: [
		{
			profile: 'CARD_480',
			url: 'https://images.test/poster-card.webp',
			width: 480,
			height: 672,
		},
		{
			profile: 'DISPLAY_960',
			url: 'https://images.test/poster-display.webp',
			width: 960,
			height: 1344,
		},
	],
};

const screenshot: ResponsiveImage = {
	original: {
		url: 'https://images.test/screenshot-original.webp',
		width: 1920,
		height: 1080,
	},
	renditions: [{
		profile: 'DISPLAY_960',
		url: 'https://images.test/screenshot-display.webp',
		width: 960,
		height: 540,
	}],
};

const project: PublicProjectDetailResponse = {
	id: 1,
	year: 2026,
	slug: 'responsive-game',
	title: 'Responsive Game',
	platforms: ['WEB'],
	isIncomplete: false,
	video: null,
	videos: [],
	members: [],
	images: [{ id: 10, kind: 'IMAGE', image: screenshot }],
	poster,
	status: 'PUBLISHED',
};

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function renderModal() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<MemoryRouter>
				<ProjectModal slug={project.slug} year={project.year} onClose={vi.fn()} />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

describe('ProjectModal responsive images', () => {
	it('uses shared candidates for media and tabs, then the original in lightbox', async () => {
		mocks.getProjectDetail.mockResolvedValue(project);
		const { container } = renderModal();

		await waitFor(() => {
			expect(container.querySelector('.modal-visual__img')).not.toBeNull();
		});

		const posterVisual = container.querySelector<HTMLImageElement>('.modal-visual__img');
		expect(posterVisual?.getAttribute('srcset')).toContain(`${poster.renditions[1]?.url} 960w`);
		expect(posterVisual?.getAttribute('sizes')).toBe('(max-width: 768px) 100vw, 960px');

		const tabs = container.querySelectorAll<HTMLImageElement>('.modal-media-tab__thumb');
		expect(tabs).toHaveLength(2);
		expect(tabs[0]?.getAttribute('sizes')).toBe('96px');

		fireEvent.click(screen.getByText('사진 1').closest('button')!);
		const screenshotVisual = container.querySelector<HTMLImageElement>('.modal-visual__img');
		expect(screenshotVisual?.getAttribute('src')).toBe(screenshot.original.url);
		expect(screenshotVisual?.getAttribute('srcset')).toContain(
			`${screenshot.renditions[0]?.url} 960w`,
		);

		fireEvent.click(screen.getByRole('button', { name: '확대해서 보기' }));
		const lightbox = screen.getByRole('img', { name: '확대 이미지' });
		expect(lightbox.getAttribute('src')).toBe(screenshot.original.url);
		expect(lightbox.getAttribute('srcset')).toBeNull();
	});
});
