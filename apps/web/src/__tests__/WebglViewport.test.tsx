/* @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebglViewport } from '../components/project/WebglViewport';
import { getWebglDisplayScale } from '../lib/webgl-display';

let resize: ResizeObserverCallback;
let fullscreenElement: Element | null;
const disconnect = vi.fn();
const requestFullscreen = vi.fn();
const exitFullscreen = vi.fn();

beforeEach(() => {
	vi.stubGlobal('ResizeObserver', class {
		constructor(callback: ResizeObserverCallback) { resize = callback; }
		observe() {}
		disconnect = disconnect;
	});
	fullscreenElement = null;
	Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement });
	Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: requestFullscreen });
	Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exitFullscreen });
	requestFullscreen.mockImplementation(() => {
		fullscreenElement = document.querySelector('.webgl-viewport');
		document.dispatchEvent(new Event('fullscreenchange'));
		return Promise.resolve();
	});
	exitFullscreen.mockImplementation(() => {
		fullscreenElement = null;
		document.dispatchEvent(new Event('fullscreenchange'));
		return Promise.resolve();
	});
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function setSize(width: number, height: number) {
	act(() => resize([{ contentRect: { width, height } } as ResizeObserverEntry], {} as ResizeObserver));
}

describe('WebGL display sizing', () => {
	it.each([[1280, 720], [720, 1280], [800, 600]])('fits %i × %i within both dimensions without enlarging normal mode', (width, height) => {
		for (const [availableWidth, availableHeight] of [[2000, 1600], [600, 900], [1000, 200]]) {
			const scale = getWebglDisplayScale(width, height, availableWidth, availableHeight, false);
			expect(scale).toBeLessThanOrEqual(1);
			expect(width * scale).toBeLessThanOrEqual(availableWidth);
			expect(height * scale).toBeLessThanOrEqual(availableHeight);
			expect(getWebglDisplayScale(width, height, availableWidth, availableHeight, true)).toBe(Math.min(availableWidth / width, availableHeight / height));
		}
	});

	it('preserves the iframe and fixed game viewport through resizing and fullscreen transitions', async () => {
		const { container } = render(<WebglViewport width={1280} height={720}><iframe title="game" src="about:blank" /></WebglViewport>);
		const iframe = screen.getByTitle('game');
		const surface = container.querySelector<HTMLElement>('.webgl-viewport__surface')!;
		setSize(640, 720);
		expect(surface.style.width).toBe('1280px');
		expect(surface.style.height).toBe('720px');
		expect(surface.style.transform).toBe('translate(-50%, -50%) scale(0.5)');
		setSize(2560, 1440);
		expect(surface.style.transform).toContain('scale(1)');
		await act(async () => fireEvent.click(screen.getByRole('button', { name: '전체화면' })));
		expect(surface.style.transform).toContain('scale(2)');
		expect(screen.getByTitle('game')).toBe(iframe);
		await act(async () => fireEvent.click(screen.getByRole('button', { name: '전체화면 종료' })));
		expect(surface.style.transform).toContain('scale(1)');
		expect(screen.getByTitle('game')).toBe(iframe);
		// A game entering its own fullscreen must not enable the host's enlargement policy.
		act(() => { fullscreenElement = iframe; document.dispatchEvent(new Event('fullscreenchange')); });
		expect(surface.style.transform).toContain('scale(1)');
	});

	it('shows fullscreen failures without unmounting the game', async () => {
		requestFullscreen.mockRejectedValueOnce(new Error('denied'));
		render(<WebglViewport width={1280} height={720}><iframe title="game" /></WebglViewport>);
		const iframe = screen.getByTitle('game');
		await act(async () => fireEvent.click(screen.getByRole('button', { name: '전체화면' })));
		expect(screen.getByRole('alert').textContent).toContain('전체화면을 전환하지 못했습니다');
		expect(screen.getByTitle('game')).toBe(iframe);
	});

	it('retains the legacy iframe class behavior when no size is set', () => {
		const { container } = render(<WebglViewport><iframe className="project-play-page__frame" title="game" /></WebglViewport>);
		expect(container.querySelector('.webgl-viewport')).toBeNull();
		expect(container.querySelector('[style]')).toBeNull();
		expect(screen.queryByRole('button')).toBeNull();
	});
});
