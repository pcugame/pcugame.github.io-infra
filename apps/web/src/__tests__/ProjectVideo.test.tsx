/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResponsiveImage } from '@pcu/contracts';

import { ProjectVideo } from '../components/project/ProjectVideo';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const poster: ResponsiveImage = {
	original: {
		url: 'https://images.test/original.webp',
		width: 1600,
		height: 900,
	},
	renditions: [
		{
			profile: 'CARD_480',
			url: 'https://images.test/card.webp',
			width: 480,
			height: 270,
		},
		{
			profile: 'DISPLAY_960',
			url: 'https://images.test/display.webp',
			width: 960,
			height: 540,
		},
	],
};

describe('ProjectVideo', () => {
	it('keeps playback available when mobile policy blocks resuming a renewed URL', async () => {
		vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
		const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(new DOMException('Tap required', 'NotAllowedError'));
		const video = { assetId: 1, sortOrder: 0, role: 'MAIN' as const, mimeType: 'video/mp4', url: 'https://videos.test/first.mp4' };
		const { container, rerender } = render(<ProjectVideo title="Game" video={video} />);
		const element = container.querySelector('video')!;
		Object.defineProperty(element, 'paused', { configurable: true, value: false });
		element.currentTime = 12;
		rerender(<ProjectVideo title="Game" video={{ ...video, url: 'https://videos.test/renewed.mp4' }} />);
		fireEvent.loadedMetadata(element);
		await waitFor(() => expect(play).toHaveBeenCalled());
		expect(element.currentTime).toBe(12);
		expect(screen.queryByRole('alert')).toBeNull();
		expect(container.querySelector('.project-video__center-play')).not.toBeNull();
		fireEvent.error(element);
		expect(screen.getByRole('alert').textContent).toContain('영상을 불러올 수 없습니다.');
	});

	it('distinguishes failed conversion from waiting and retains original download', () => {
		const { container } = render(<ProjectVideo title="QuickService" video={{ assetId: 769, sortOrder: 0, role: 'MAIN', mimeType: 'video/mp4', playbackStatus: 'FAILED', originalDownloadUrl: 'https://videos.test/original.mp4' }} />);
		expect(container.textContent).toContain('변환에 실패했습니다');
		expect(container.querySelector('a')?.getAttribute('href')).toBe('https://videos.test/original.mp4');
		expect(container.querySelector('video')).toBeNull();
	});
	it('uses the closest DISPLAY_960 candidate for the video poster attribute', () => {
		const { container } = render(
			<ProjectVideo
				video={{ assetId: 1, sortOrder: 0, role: 'MAIN', url: 'https://videos.test/video.mp4', mimeType: 'video/mp4' }}
				poster={poster}
				title="Game"
			/>,
		);

		expect(container.querySelector('video')?.getAttribute('poster')).toBe(
			'https://images.test/display.webp',
		);
	});

	it('uses the original when it is smaller than the video poster target', () => {
		const smallPoster: ResponsiveImage = {
			original: { url: 'https://images.test/small.webp', width: 700, height: 394 },
			renditions: [{
				profile: 'CARD_480',
				url: 'https://images.test/small-card.webp',
				width: 480,
				height: 270,
			}],
		};
		const { container } = render(
			<ProjectVideo
				video={{ assetId: 1, sortOrder: 0, role: 'MAIN', url: 'https://videos.test/video.mp4', mimeType: 'video/mp4' }}
				poster={smallPoster}
				title="Game"
			/>,
		);

		expect(container.querySelector('video')?.getAttribute('poster')).toBe(
			smallPoster.original.url,
		);
	});

	it('hides playback and preserves the original download when playback failed', () => {
		const { container } = render(
			<ProjectVideo
				video={{
					assetId: 42,
					sortOrder: 0,
					role: 'MAIN',
					mimeType: 'video/quicktime',
					originalDownloadUrl: 'https://api.test/api/assets/42/download?variant=original',
					playbackStatus: 'FAILED',
					playbackError: 'encoder failed',
				}}
				poster={poster}
				title="Game"
			/>,
		);

		expect(container.querySelector('video')).toBeNull();
		expect(screen.getByRole('link', { name: '동영상 원본 다운로드' }).getAttribute('href'))
			.toBe('https://api.test/api/assets/42/download?variant=original');
	});
});
