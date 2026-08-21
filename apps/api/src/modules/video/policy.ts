import type { VideoProbe } from './ports.js';
import { VideoRejectedError } from './errors.js';

export const DEFAULT_VIDEO_LIMITS = Object.freeze({
	maxSourceBytes: 1024 * 1024 * 1024,
	maxPlaybackBytes: 1024 * 1024 * 1024,
	maxDurationSeconds: 30 * 60,
	maxSourceWidth: 7_680,
	maxSourceHeight: 4_320,
	maxSourcePixels: 33_177_600,
	maxSourceFrameRate: 120,
	maxSourceBitRate: 100_000_000,
	maxStreams: 16,
	maxPlaybackWidth: 1_920,
	maxPlaybackHeight: 1_080,
	maxPlaybackFrameRate: 30,
	maxPlaybackBitRate: 5_500_000,
	probeTimeoutMs: 60_000,
	decodeTimeoutMs: 35 * 60_000,
	transcodeTimeoutMs: 35 * 60_000,
	commandOutputBytes: 256 * 1024,
});

export type VideoLimits = typeof DEFAULT_VIDEO_LIMITS;

const SOURCE_FORMATS = new Set([
	'mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2',
	'matroska', 'webm', 'avi', 'asf',
]);
const VIDEO_CODECS = new Set([
	'h264', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg4', 'mpeg2video', 'wmv3', 'vc1',
]);
const AUDIO_CODECS = new Set([
	'', 'aac', 'mp3', 'opus', 'vorbis', 'flac', 'ac3', 'eac3', 'wmav2',
]);

function finitePositive(value: number): boolean {
	return Number.isFinite(value) && value > 0;
}

export function assertSourceVideoPolicy(probe: VideoProbe, limits: VideoLimits): void {
	if (!probe.formatNames.some((name) => SOURCE_FORMATS.has(name))) {
		throw new VideoRejectedError('Unsupported video container', 'CONTAINER_INVALID');
	}
	if (probe.videoStreamCount !== 1 || probe.audioStreamCount > 1
		|| probe.streamCount < 1 || probe.streamCount > limits.maxStreams) {
		throw new VideoRejectedError('Unsupported video stream layout', 'CONTAINER_INVALID');
	}
	if (!VIDEO_CODECS.has(probe.videoCodec) || !AUDIO_CODECS.has(probe.audioCodec)) {
		throw new VideoRejectedError('Unsupported video or audio codec', 'CODEC_UNSUPPORTED');
	}
	if (!finitePositive(probe.width) || !finitePositive(probe.height)
		|| probe.width > limits.maxSourceWidth || probe.height > limits.maxSourceHeight
		|| probe.width * probe.height > limits.maxSourcePixels) {
		throw new VideoRejectedError('Video dimensions exceed processing policy', 'RESOURCE_LIMIT');
	}
	if (!finitePositive(probe.durationSeconds)
		|| probe.durationSeconds > limits.maxDurationSeconds
		|| !Number.isFinite(probe.frameRate) || probe.frameRate < 0
		|| probe.frameRate > limits.maxSourceFrameRate
		|| !Number.isFinite(probe.bitRate) || probe.bitRate < 0
		|| probe.bitRate > limits.maxSourceBitRate) {
		throw new VideoRejectedError('Video duration, frame rate, or bitrate exceeds policy', 'RESOURCE_LIMIT');
	}
}

export function isBrowserSafeVideo(probe: VideoProbe, limits: VideoLimits): boolean {
	return probe.formatNames.includes('mp4')
		&& probe.videoCodec === 'h264'
		&& probe.pixelFormat === 'yuv420p'
		&& (probe.audioCodec === '' || probe.audioCodec === 'aac')
		&& probe.fastStart
		&& probe.width <= limits.maxPlaybackWidth
		&& probe.height <= limits.maxPlaybackHeight
		&& (probe.frameRate === 0 || probe.frameRate <= limits.maxPlaybackFrameRate)
		&& (probe.bitRate === 0 || probe.bitRate <= limits.maxPlaybackBitRate);
}

export function canRemuxVideo(probe: VideoProbe, limits: VideoLimits): boolean {
	return probe.formatNames.includes('mp4')
		&& probe.videoCodec === 'h264'
		&& probe.pixelFormat === 'yuv420p'
		&& (probe.audioCodec === '' || probe.audioCodec === 'aac')
		&& probe.width <= limits.maxPlaybackWidth
		&& probe.height <= limits.maxPlaybackHeight
		&& (probe.frameRate === 0 || probe.frameRate <= limits.maxPlaybackFrameRate)
		&& (probe.bitRate === 0 || probe.bitRate <= limits.maxPlaybackBitRate);
}

export function assertBrowserSafeOutput(probe: VideoProbe, limits: VideoLimits): void {
	if (!isBrowserSafeVideo(probe, limits)) {
		throw new VideoRejectedError('Generated playback is not browser-safe', 'CORRUPT_MEDIA');
	}
}
