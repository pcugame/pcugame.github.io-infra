/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectActions } from '../components/project/ProjectActions';
import ProjectPlayPage from '../pages/ProjectPlayPage';

const mocks = vi.hoisted(() => ({ getProjectDetail: vi.fn(), graphics: vi.fn() }));
vi.mock('../lib/graphicsAcceleration', () => ({ detectGraphicsAcceleration: mocks.graphics }));
// Exercise player controls with a settled viewer; auth transitions have their
// own tests and must not replace the iframe midway through these assertions.
vi.mock('../features/auth', () => ({ useMe: () => ({ user: null, isPending: false }) }));
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
	beforeEach(() => {
		Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
		Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function(this: HTMLDialogElement) { this.removeAttribute('open'); } });
		mocks.getProjectDetail.mockReset();
		mocks.graphics.mockReset().mockReturnValue('available');
	});
	afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

	it('only restarts the game after confirmation and preserves iframe isolation', async () => {
		mocks.getProjectDetail.mockResolvedValue(project('https://assets.example.com/play/game/index.html'));
		renderPlayPage();
		const originalFrame = await screen.findByTitle('웹 게임 WebGL 플레이어');
		const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
		fireEvent.click(screen.getByRole('button', { name: '게임 다시 시작' }));
		expect(screen.getByTitle('웹 게임 WebGL 플레이어')).toBe(originalFrame);
		confirm.mockReturnValue(true);
		fireEvent.click(screen.getByRole('button', { name: '게임 다시 시작' }));
		const restartedFrame = screen.getByTitle('웹 게임 WebGL 플레이어');
		expect(restartedFrame).not.toBe(originalFrame);
		expect(restartedFrame.getAttribute('src')).toBe(originalFrame.getAttribute('src'));
		expect(restartedFrame.getAttribute('sandbox')).toBe(originalFrame.getAttribute('sandbox'));
		expect(restartedFrame.hasAttribute('credentialless')).toBe(true);
	});

	it('offers a downloadable build when available without claiming a browser is unsupported', async () => {
		mocks.getProjectDetail.mockResolvedValue({ ...project('https://assets.example.com/play/game/index.html'), gameDownloadUrl: 'https://api.example.com/game.zip' });
		renderPlayPage();
		const download = await screen.findByRole('link', { name: '게임 다운로드 (ZIP)' });
		expect(download.getAttribute('href')).toBe('https://api.example.com/game.zip');
		expect(screen.getByText('게임이 실행되지 않나요?')).toBeTruthy();
		expect(screen.queryByText(/Chrome.*필수|Firefox.*지원하지/)).toBeNull();
	});

	it.each(['software', 'performance-caveat', 'unavailable'])('holds the iframe for %s until the visitor continues', async (status) => {
		mocks.graphics.mockReturnValue(status);
		mocks.getProjectDetail.mockResolvedValue(project('https://assets.example.com/game/'));
		renderPlayPage();
		await screen.findByRole('heading', { name: '그래픽 가속 설정을 확인해 주세요' });
		expect(screen.getByRole('dialog', { name: '그래픽 가속 설정을 확인해 주세요' }).hasAttribute('open')).toBe(true);
		expect(document.body.style.overflow).toBe('hidden');
		expect(screen.queryByTitle(/WebGL 플레이어/)).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: '그래도 실행' }));
		expect(screen.getByTitle('웹 게임 WebGL 플레이어')).toBeTruthy();
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(document.body.style.overflow).not.toBe('hidden');
	});

	it('checks again, retains the warning on failure, then starts when acceleration is available', async () => {
		mocks.graphics.mockReturnValue('software');
		mocks.getProjectDetail.mockResolvedValue(project('https://assets.example.com/game/'));
		renderPlayPage();
		fireEvent.click(await screen.findByRole('button', { name: '설정 후 다시 확인' }));
		await screen.findByRole('button', { name: '설정 후 다시 확인' });
		expect(screen.queryByTitle(/WebGL 플레이어/)).toBeNull();
		mocks.graphics.mockReturnValue('available');
		fireEvent.click(screen.getByRole('button', { name: '설정 후 다시 확인' }));
		expect(await screen.findByTitle('웹 게임 WebGL 플레이어')).toBeTruthy();
	});

	it('allows an inconclusive result without claiming acceleration is disabled', async () => {
		mocks.graphics.mockReturnValue('unknown');
		mocks.getProjectDetail.mockResolvedValue(project('https://assets.example.com/game/'));
		renderPlayPage();
		expect(await screen.findByTitle('웹 게임 WebGL 플레이어')).toBeTruthy();
		expect(screen.queryByRole('heading', { name: '그래픽 가속 설정을 확인해 주세요' })).toBeNull();
	});

	it('provides a working help hyperlink without copy buttons or internal settings links', async () => {
		vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Chrome/150.0 Safari/537.36');
		mocks.graphics.mockReturnValue('software');
		mocks.getProjectDetail.mockResolvedValue(project('https://assets.example.com/game/'));
		renderPlayPage();
		await screen.findByRole('dialog');
		const help = screen.getByRole('link', { name: /설정 방법 보기/ });
		expect(help.getAttribute('href')).toMatch(/^https:\/\//);
		expect(help.getAttribute('target')).not.toBe('_blank');
		expect(screen.queryByRole('button', { name: /복사/ })).toBeNull();
		expect(screen.queryByRole('textbox')).toBeNull();
	});

	it.each(['close', 'escape'])('cancels via %s without loading the game', async (method) => {
		mocks.graphics.mockReturnValue('software');
		mocks.getProjectDetail.mockResolvedValue(project('https://assets.example.com/game/'));
		renderPlayPage();
		const dialog = await screen.findByRole('dialog');
		if (method === 'escape') fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }));
		else fireEvent.click(screen.getByRole('button', { name: '플레이 취소하고 작품으로 돌아가기' }));
		expect(await screen.findByText('detail')).toBeTruthy();
		expect(screen.queryByTitle(/WebGL 플레이어/)).toBeNull();
		expect(document.body.style.overflow).not.toBe('hidden');
	});

	it('enlarges the settings screenshot and closes only the image on Escape', async () => {
		vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Chrome/150.0 Safari/537.36');
		mocks.graphics.mockReturnValue('software');
		mocks.getProjectDetail.mockResolvedValue(project('https://assets.example.com/game/'));
		renderPlayPage();
		fireEvent.click(await screen.findByRole('button', { name: '설정 화면 크게 보기' }));
		const imageDialog = screen.getByRole('dialog', { name: '브라우저 설정 화면' });
		expect(screen.getAllByRole('dialog')).toHaveLength(2);
		fireEvent(imageDialog, new Event('cancel', { bubbles: false, cancelable: true }));
		expect(screen.queryByRole('dialog', { name: '브라우저 설정 화면' })).toBeNull();
		expect(screen.getByRole('dialog', { name: '그래픽 가속 설정을 확인해 주세요' })).toBeTruthy();
		expect(document.body.style.overflow).toBe('hidden');
		expect(screen.queryByTitle(/WebGL 플레이어/)).toBeNull();
	});

	it('renders a credentialless Unity-compatible iframe without navigation permissions', async () => {
		mocks.getProjectDetail.mockResolvedValue(project('https://api.example.com/api/public/webgl/7/'));
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
		mocks.getProjectDetail.mockResolvedValue(project());
		renderPlayPage();
		expect(await screen.findByText('플레이할 WebGL 빌드가 없습니다.')).toBeTruthy();
		expect(screen.queryByTitle(/WebGL 플레이어/)).toBeNull();
		expect(screen.getByRole('link', { name: '작품으로 돌아가기' }).getAttribute('href')).toBe('/projects/7');
		expect(mocks.graphics).not.toHaveBeenCalled();
	});

	it('does not remember a bypass after leaving the player', async () => {
		mocks.graphics.mockReturnValue('software');
		mocks.getProjectDetail.mockResolvedValue(project('https://assets.example.com/game/'));
		const first = renderPlayPage();
		fireEvent.click(await screen.findByRole('button', { name: '그래도 실행' }));
		expect(screen.getByTitle('웹 게임 WebGL 플레이어')).toBeTruthy();
		first.unmount();
		renderPlayPage();
		await screen.findByRole('button', { name: '그래도 실행' });
		expect(screen.queryByTitle(/WebGL 플레이어/)).toBeNull();
	});

	it('opens the stable dedicated runtime URL in an isolated new tab', () => {
		render(<MemoryRouter><ProjectActions projectId={7} webglUrl="https://files.test/play/old/index.html" webglPlayUrl="https://api.test/play/projects/7" /></MemoryRouter>);
		const link = screen.getByRole('link', { name: '플레이해보기' });
		expect(link.getAttribute('href')).toBe('https://api.test/play/projects/7');
		expect(link.getAttribute('target')).toBe('_blank');
		expect(link.getAttribute('rel')).toContain('noopener');
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
