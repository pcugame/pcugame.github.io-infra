/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicYearListResponse } from '../contracts';

const mocks = vi.hoisted(() => ({
	getYears: vi.fn(),
	useMe: vi.fn(),
}));

vi.mock('../lib/api', () => ({
	publicApi: { getYears: mocks.getYears },
}));

vi.mock('../features/auth', () => ({
	useMe: mocks.useMe,
}));

import HomePage from '../pages/HomePage';
import YearsPage from '../pages/YearsPage';

const response = {
	items: [{
		id: 1,
		year: 2026,
		title: '2026 전시',
		projectCount: 12,
		poster: {
			original: {
				url: 'https://images.test/poster-original.webp',
				width: 1200,
				height: 1680,
			},
			renditions: [{
				profile: 'CARD_480',
				url: 'https://images.test/poster-card.webp',
				width: 480,
				height: 672,
			}],
		},
	}],
} satisfies PublicYearListResponse;

afterEach(cleanup);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.useMe.mockReturnValue({ isAuthenticated: false, user: null });
	mocks.getYears.mockResolvedValue(response);
});

function renderPage(page: ReactNode) {
	return render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<MemoryRouter>{page}</MemoryRouter>
		</QueryClientProvider>,
	);
}

describe('public archive poster loading', () => {
	it('renders HomePage posters eagerly while preserving responsive candidates', async () => {
		renderPage(<HomePage />);

		const poster = await screen.findByRole('img', { name: '2026 전시 전시회 포스터' });
		expect(poster.getAttribute('src')).toBe(response.items[0].poster?.original.url);
		expect(poster.getAttribute('srcset')).toContain('https://images.test/poster-card.webp 480w');
		expect(poster.getAttribute('sizes')).toBe('(max-width: 640px) 88vw, (max-width: 1100px) 44vw, 420px');
		expect(poster.getAttribute('loading')).toBe('eager');
		expect(poster.getAttribute('decoding')).toBe('async');
		expect(poster.getAttribute('fetchpriority')).toBeNull();
	});

	it('renders YearsPage posters eagerly while preserving responsive candidates', async () => {
		const { container } = renderPage(<YearsPage />);

		await screen.findByText('2026 전시');
		const poster = container.querySelector<HTMLImageElement>('.years-card__poster img');
		expect(poster).not.toBeNull();
		expect(poster?.getAttribute('src')).toBe(response.items[0].poster?.original.url);
		expect(poster?.getAttribute('srcset')).toContain('https://images.test/poster-card.webp 480w');
		expect(poster?.getAttribute('sizes')).toBe('(max-width: 640px) 38vw, (max-width: 1100px) 24vw, 240px');
		expect(poster?.getAttribute('loading')).toBe('eager');
		expect(poster?.getAttribute('decoding')).toBe('async');
		expect(poster?.getAttribute('fetchpriority')).toBeNull();
	});
});
