/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectActions } from '../components/project/ProjectActions';
import ProjectPlayPage from '../pages/ProjectPlayPage';

const mocks = vi.hoisted(() => ({ getProjectDetail: vi.fn() }));
vi.mock('../lib/api', async (importOriginal) => {
	const original = await importOriginal<typeof import('../lib/api')>();
	return {
		...original,
		publicApi: { ...original.publicApi, getProjectDetail: mocks.getProjectDetail },
	};
});

function project(webglUrl?: string) {
	return {
		id: 7,
		year: 2026,
		slug: 'web-game',
		title: '웹 게임',
		platforms: ['WEB'] as const,
		isIncomplete: false,
		video: null,
		videos: [],
		members: [],
		images: [],
		status: 'PUBLISHED' as const,
		webglUrl,
	};
}

function renderPlayPage() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={['/projects/7/play']}>
				<Routes>
					<Route path="/projects/:projectId/play" element={<ProjectPlayPage />} />
					<Route path="/projects/:projectId" element={<div>detail</div>} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

describe('WebGL public frontend', () => {
	beforeEach(() => vi.clearAllMocks());
	afterEach(cleanup);

	it('renders a credentialless Unity-compatible iframe without navigation permissions', async () => {
		mocks.getProjectDetail.mockResolvedValueOnce(project('https://api.example.com/api/public/webgl/7/'));
		renderPlayPage();
		const iframe = await screen.findByTitle('웹 게임 WebGL 플레이어');
		expect(iframe.getAttribute('src')).toBe('https://api.example.com/api/public/webgl/7/');
		expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-pointer-lock allow-same-origin');
		expect(iframe.hasAttribute('credentialless')).toBe(true);
		expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer');
		expect(iframe.getAttribute('allow')).toBe('fullscreen; autoplay');
		const sandbox = iframe.getAttribute('sandbox') ?? '';
		expect(sandbox).toContain('allow-same-origin');
		expect(sandbox).not.toContain('allow-forms');
		expect(sandbox).not.toContain('allow-popups');
		expect(sandbox).not.toContain('allow-top-navigation');
	});

	it('shows a no-build state and a way back instead of an iframe', async () => {
		mocks.getProjectDetail.mockResolvedValueOnce(project());
		renderPlayPage();
		expect(await screen.findByText('플레이할 WebGL 빌드가 없습니다.')).toBeTruthy();
		expect(screen.queryByTitle(/WebGL 플레이어/)).toBeNull();
		expect(screen.getByRole('link', { name: '작품으로 돌아가기' }).getAttribute('href')).toBe('/projects/7');
	});

	it('shows play independently when there is no downloadable GAME ZIP', () => {
		render(
			<MemoryRouter>
				<ProjectActions projectId={7} webglUrl="https://api.example.com/api/public/webgl/7/" />
			</MemoryRouter>,
		);
		expect(screen.getByRole('link', { name: '플레이해보기' }).getAttribute('href')).toBe('/projects/7/play');
		expect(screen.queryByRole('link', { name: /다운로드/ })).toBeNull();
	});
});
