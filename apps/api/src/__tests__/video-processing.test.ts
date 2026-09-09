import { describe, expect, it } from 'vitest';
import { decideStrategy, isSmoothPlayback, type ProbeResult } from '../modules/assets/upload/video-processing.js';

function probe(overrides: Partial<ProbeResult> = {}): ProbeResult {
	return {
		formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
		videoCodec: 'h264',
		audioCodec: 'aac',
		pixelFormat: 'yuv420p',
		width: 1920,
		height: 1080,
		frameRate: 30,
		bitRate: 5_000_000,
		fastStart: true,
		...overrides,
	};
}

describe('video playback decisions', () => {
	it('accepts already smooth browser playback MP4', () => {
		expect(isSmoothPlayback('mp4', probe())).toBe(true);
		expect(decideStrategy('mp4', probe())).toBe('passthrough');
	});

	it('remuxes otherwise compliant MP4 when only faststart is missing', () => {
		const p = probe({ fastStart: false });
		expect(isSmoothPlayback('mp4', p)).toBe(false);
		expect(decideStrategy('mp4', p)).toBe('remux');
	});

	it('reencodes when codec, pixel format, dimensions, frame rate, or bitrate exceed playback limits', () => {
		expect(decideStrategy('mp4', probe({ videoCodec: 'hevc' }))).toBe('reencode');
		expect(decideStrategy('mp4', probe({ pixelFormat: 'yuv422p' }))).toBe('reencode');
		expect(decideStrategy('mp4', probe({ width: 3840, height: 2160 }))).toBe('reencode');
		expect(decideStrategy('mp4', probe({ frameRate: 60 }))).toBe('reencode');
		expect(decideStrategy('mp4', probe({ bitRate: 12_000_000 }))).toBe('reencode');
	});

	it('reencodes non-aac audio instead of treating it as smooth', () => {
		const p = probe({ audioCodec: 'mp3' });
		expect(isSmoothPlayback('mp4', p)).toBe(false);
		expect(decideStrategy('mp4', p)).toBe('reencode');
	});

	it('allows silent video', () => {
		expect(isSmoothPlayback('mp4', probe({ audioCodec: '' }))).toBe(true);
	});
});
