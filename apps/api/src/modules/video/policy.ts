import { videoPlaybackRenditionKey, type VideoPlaybackQuality } from '@pcu/contracts';
import type { VideoProbe, VerifyingVideoSession } from './ports.js';
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
	maxPlaybackFrameRate: 120,
	maxPlaybackBitRate: 20_200_000,
	probeTimeoutMs: 60_000,
	decodeTimeoutMs: 35 * 60_000,
	transcodeTimeoutMs: 35 * 60_000,
	commandOutputBytes: 256 * 1024,
});

export type VideoLimits = typeof DEFAULT_VIDEO_LIMITS;

export function isVideoPlaybackRepair(session: Pick<VerifyingVideoSession, 'completionResult' | 'resultAssetId' | 'resultRepresentationId'>): boolean {
	return session.resultAssetId !== null && session.resultRepresentationId !== null
		&& session.completionResult !== null && typeof session.completionResult === 'object'
		&& 'phase' in session.completionResult && session.completionResult.phase === 'PLAYBACK_REPAIR';
}

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

// Remuxing can round track durations (e.g. 30fps becomes 30.000013fps).
// Allow a thousandth of a frame per second without accepting higher-rate video.
const FRAME_RATE_ROUNDING_TOLERANCE = 0.001;

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
		|| probe.frameRate > limits.maxSourceFrameRate + FRAME_RATE_ROUNDING_TOLERANCE
		|| !Number.isFinite(probe.bitRate) || probe.bitRate < 0
		|| probe.bitRate > limits.maxSourceBitRate) {
		throw new VideoRejectedError('Video duration, frame rate, or bitrate exceeds policy', 'RESOURCE_LIMIT');
	}
}

export function isBrowserSafeVideo(probe: VideoProbe, limits: VideoLimits): boolean {
	return probe.formatNames.includes('mp4')
		&& probe.containerMajorBrand?.trim() !== 'qt'
		&& probe.videoCodec === 'h264'
		&& probe.pixelFormat === 'yuv420p'
		&& (probe.audioCodec === '' || probe.audioCodec === 'aac')
		&& probe.fastStart
		&& probe.width <= limits.maxPlaybackWidth
		&& probe.height <= limits.maxPlaybackHeight
		&& (probe.frameRate === 0 || probe.frameRate <= limits.maxPlaybackFrameRate + FRAME_RATE_ROUNDING_TOLERANCE)
		&& (probe.bitRate === 0 || probe.bitRate <= Math.min(limits.maxPlaybackBitRate, playbackBitRate(probe.frameRate) + 200_000));
}

export function canRemuxVideo(probe: VideoProbe, limits: VideoLimits): boolean {
	return probe.formatNames.some(name => SOURCE_FORMATS.has(name))
		&& probe.videoCodec === 'h264'
		&& probe.pixelFormat === 'yuv420p'
		&& (probe.audioCodec === '' || probe.audioCodec === 'aac')
		&& probe.width <= limits.maxPlaybackWidth
		&& probe.height <= limits.maxPlaybackHeight
		&& (probe.frameRate === 0 || probe.frameRate <= limits.maxPlaybackFrameRate + FRAME_RATE_ROUNDING_TOLERANCE)
		&& (probe.bitRate === 0 || probe.bitRate <= Math.min(limits.maxPlaybackBitRate, playbackBitRate(probe.frameRate) + 200_000));
}

export function assertBrowserSafeOutput(probe: VideoProbe, limits: VideoLimits): void {
	if (!isBrowserSafeVideo(probe, limits)) {
		throw new VideoRejectedError('Generated playback is not browser-safe', 'CORRUPT_MEDIA');
	}
}

export type PlaybackProfile = 'native' | 'cap60' | 'cap30';
export function playbackProfiles(frameRate: number): { profile: PlaybackProfile; divisor: number }[] {
 const result: { profile: PlaybackProfile; divisor: number }[] = [{ profile: 'native', divisor: 1 }];
 for (const [profile, cap] of [['cap60', 60], ['cap30', 30]] as const) {
  let divisor = 1;
  while (frameRate / divisor > cap + FRAME_RATE_ROUNDING_TOLERANCE) divisor *= 2;
  if (!result.some(item => item.divisor === divisor)) result.push({ profile, divisor });
 }
 return result;
}
export function playbackBitRate(frameRate: number): number {
 return frameRate <= 30.001 ? 6_000_000 : frameRate <= 60.001 ? 12_000_000 : 20_000_000;
}

/** Resolution bounds match the existing landscape 1080p box; never upscale. */
export function playbackQualityBounds(quality: VideoPlaybackQuality, limits: VideoLimits) {
 const height = quality === 'max' ? limits.maxPlaybackHeight : 720;
 return { width: limits.maxPlaybackWidth, height: Math.min(limits.maxPlaybackHeight, height) };
}
export function playbackRenditions(probe: Pick<VideoProbe, 'width' | 'height' | 'frameRate' | 'nominalFrameRate'>, limits: VideoLimits) {
 const qualities: VideoPlaybackQuality[] = [];
 const dimensions = new Set<string>();
 for (const quality of ['max', '720p'] as const) {
  const box = playbackQualityBounds(quality, limits);
  const scale = Math.min(1, box.width / probe.width, box.height / probe.height);
  const size = `${Math.floor(probe.width * scale / 2) * 2}x${Math.floor(probe.height * scale / 2) * 2}`;
  if (!dimensions.has(size)) { qualities.push(quality); dimensions.add(size); }
 }
 return qualities.flatMap(quality => playbackProfiles(Math.max(probe.frameRate, probe.nominalFrameRate ?? 0))
  .map(item => ({ ...item, quality, key: videoPlaybackRenditionKey(item.profile, quality) })));
}
