/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphicsAccelerationGuide } from '../components/project/GraphicsAccelerationGuide';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('compact browser guidance', () => {
	it('shows three desktop menu steps, a same-tab HTTPS help link and collapsed override', async () => {
		vi.stubGlobal('navigator', { userAgent: 'Chrome/150.0 Safari/537.36', platform: 'Linux', maxTouchPoints: 0 });
		await act(async () => { render(<GraphicsAccelerationGuide />); });
		expect(screen.getByText('Chrome · 컴퓨터')).toBeTruthy();
		expect(screen.getAllByRole('listitem')).toHaveLength(3);
		const help = screen.getByRole('link', { name: '설정 방법 보기' });
		expect(help.getAttribute('href')).toMatch(/^https:\/\/support\.google\.com\//);
		expect(help.hasAttribute('target')).toBe(false);
		expect(screen.getByText('다른 브라우저 안내').closest('details')?.open).toBe(false);
		expect(screen.queryByRole('textbox')).toBeNull();
		expect(screen.queryByRole('button', { name: /복사/ })).toBeNull();
	});

	it('retains a manual browser choice when delayed Brave detection completes', async () => {
		let finish!: (value: boolean) => void;
		const brave = new Promise<boolean>((resolve) => { finish = resolve; });
		vi.stubGlobal('navigator', {
			userAgent: 'Chrome/150.0 Safari/537.36', platform: 'Linux', maxTouchPoints: 0,
			brave: { isBrave: () => brave },
		});
		render(<GraphicsAccelerationGuide />);
		const summary = screen.getByText('다른 브라우저 안내');
		summary.closest('details')!.open = true;
		fireEvent.change(screen.getByLabelText('사용 중인 브라우저'), { target: { value: 'firefox' } });
		await act(async () => { finish(true); await brave; });
		expect(screen.getByText('Firefox · 컴퓨터')).toBeTruthy();
		expect(screen.getByText('직접 선택')).toBeTruthy();
		expect(screen.getByRole('link', { name: '설정 방법 보기' }).getAttribute('href')).toBe('https://support.mozilla.org/ko/kb/performance-settings');
	});

	it('offers Brave instructions by manual choice when browser privacy hides its brand', async () => {
		vi.stubGlobal('navigator', { userAgent: 'Chrome/150.0 Safari/537.36', platform: 'Linux', maxTouchPoints: 0 });
		await act(async () => { render(<GraphicsAccelerationGuide />); });
		screen.getByText('다른 브라우저 안내').closest('details')!.open = true;
		fireEvent.change(screen.getByLabelText('사용 중인 브라우저'), { target: { value: 'brave' } });
		expect(screen.getByText('Brave · 컴퓨터')).toBeTruthy();
		expect(screen.getByText('brave://settings/system')).toBeTruthy();
		expect(screen.getByAltText('Brave 시스템 설정의 그래픽 가속 사용 옵션')).toBeTruthy();
	});

	it('shows mobile-specific fallback instructions without a desktop hardware toggle', async () => {
		vi.stubGlobal('navigator', { userAgent: 'Android Chrome/150.0 Mobile Safari/537.36', platform: 'Linux', maxTouchPoints: 5 });
		await act(async () => { render(<GraphicsAccelerationGuide />); });
		expect(screen.getByText('Chrome · 모바일')).toBeTruthy();
		expect(screen.queryByText(/가속 사용.*켜세요/)).toBeNull();
		expect(screen.queryByRole('link', { name: '설정 방법 보기' })).toBeNull();
	});
});
