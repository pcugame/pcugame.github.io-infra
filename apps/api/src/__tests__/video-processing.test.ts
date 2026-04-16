import { describe, it, expect } from 'vitest';
import { decideStrategy } from '../modules/assets/upload/video-processing.js';

describe('decideStrategy', () => {
	it('passes through mp4 with h264+aac', () => {
		expect(decideStrategy('mp4', { videoCodec: 'h264', audioCodec: 'aac' }))
			.toBe('passthrough');
	});

	it('passes through mp4 with h264 and no audio', () => {
		expect(decideStrategy('mp4', { videoCodec: 'h264', audioCodec: '' }))
			.toBe('passthrough');
	});

	it('passes through mp4 with h264+mp3', () => {
		expect(decideStrategy('mp4', { videoCodec: 'h264', audioCodec: 'mp3' }))
			.toBe('passthrough');
	});

	it('remuxes mkv with h264+aac', () => {
		expect(decideStrategy('mkv', { videoCodec: 'h264', audioCodec: 'aac' }))
			.toBe('remux');
	});

	it('remuxes mov with h264+aac', () => {
		expect(decideStrategy('mp4', { videoCodec: 'hevc', audioCodec: 'aac' }))
			.toBe('remux');
	});

	it('remuxes mp4 with h264+opus (not browser-playable audio)', () => {
		expect(decideStrategy('mp4', { videoCodec: 'h264', audioCodec: 'opus' }))
			.toBe('remux');
	});

	it('remuxes webm with vp9+opus', () => {
		expect(decideStrategy('webm', { videoCodec: 'vp9', audioCodec: 'opus' }))
			.toBe('remux');
	});

	it('re-encodes wmv with wmv3+wmav2', () => {
		expect(decideStrategy('wmv', { videoCodec: 'wmv3', audioCodec: 'wmav2' }))
			.toBe('reencode');
	});

	it('re-encodes avi with msmpeg4v3+mp3', () => {
		expect(decideStrategy('avi', { videoCodec: 'msmpeg4v3', audioCodec: 'mp3' }))
			.toBe('reencode');
	});

	it('re-encodes when video codec is incompatible', () => {
		expect(decideStrategy('mkv', { videoCodec: 'vp8', audioCodec: 'vorbis' }))
			.toBe('reencode');
	});
});
