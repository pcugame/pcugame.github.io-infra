/**
 * Video playback preparation.
 *
 * The original upload is preserved. This module only decides whether that
 * original is already smooth enough for browser playback, or creates a
 * separate playback MP4 when needed.
 */

import type { AppLogger } from '../../../application/ports.js';

const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1080;
const MAX_FRAME_RATE = 30;
const MAX_TOTAL_BITRATE = 5_500_000;

export interface VideoProcessingInput {
	tmpPath: string;
	mimeType: string;
	ext: string;
	sizeBytes: number;
}

export type VideoPlaybackStatus = 'READY' | 'FAILED';

export interface VideoPlaybackFile {
	tmpPath: string;
	mimeType: string;
	ext: string;
	sizeBytes: number;
}

export interface VideoProcessingResult {
	playback: VideoPlaybackFile | null;
	playbackStatus: VideoPlaybackStatus;
	playbackError: string;
	converted: boolean;
	strategy: ConversionStrategy;
	probe?: ProbeResult;
}

export interface ProbeResult {
	formatName: string;
	videoCodec: string;
	audioCodec: string;
	pixelFormat: string;
	width: number;
	height: number;
	frameRate: number;
	bitRate: number;
	fastStart: boolean;
}

export type ConversionStrategy = 'passthrough' | 'remux' | 'reencode' | 'failed';

function normalizeExt(ext: string): string {
	return ext.replace(/^\./, '').toLowerCase();
}

export function isSmoothPlayback(ext: string, probe: ProbeResult): boolean {
	const normalizedExt = normalizeExt(ext);
	const audioOk = probe.audioCodec === '' || probe.audioCodec === 'aac';
	const bitRateOk = probe.bitRate === 0 || probe.bitRate <= MAX_TOTAL_BITRATE;

	return normalizedExt === 'mp4'
		&& probe.videoCodec === 'h264'
		&& probe.pixelFormat === 'yuv420p'
		&& audioOk
		&& probe.fastStart
		&& probe.width > 0
		&& probe.height > 0
		&& probe.width <= MAX_WIDTH
		&& probe.height <= MAX_HEIGHT
		&& (probe.frameRate === 0 || probe.frameRate <= MAX_FRAME_RATE)
		&& bitRateOk;
}

function canRemuxToSmooth(ext: string, probe: ProbeResult): boolean {
	const normalizedExt = normalizeExt(ext);
	const audioOk = probe.audioCodec === '' || probe.audioCodec === 'aac';
	const bitRateOk = probe.bitRate === 0 || probe.bitRate <= MAX_TOTAL_BITRATE;

	return normalizedExt === 'mp4'
		&& probe.videoCodec === 'h264'
		&& probe.pixelFormat === 'yuv420p'
		&& audioOk
		&& probe.width > 0
		&& probe.height > 0
		&& probe.width <= MAX_WIDTH
		&& probe.height <= MAX_HEIGHT
		&& (probe.frameRate === 0 || probe.frameRate <= MAX_FRAME_RATE)
		&& bitRateOk;
}

export function decideStrategy(ext: string, probe: ProbeResult): ConversionStrategy {
	if (isSmoothPlayback(ext, probe)) return 'passthrough';
	if (canRemuxToSmooth(ext, probe)) return 'remux';
	return 'reencode';
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export interface VideoProcessingOperations {
	probe(filePath: string): Promise<ProbeResult>;
	remux(inputPath: string, outputPath: string): Promise<void>;
	reencode(inputPath: string, outputPath: string): Promise<void>;
	remove(filePath: string): Promise<void>;
	stat(filePath: string): Promise<{ size: number }>;
}

export async function processVideo(
	input: VideoProcessingInput,
	logger: Pick<AppLogger, 'info' | 'warn' | 'error'>,
	operations: VideoProcessingOperations,
): Promise<VideoProcessingResult> {
	try {
		const probe = await operations.probe(input.tmpPath);
		const strategy = decideStrategy(input.ext, probe);
		logger.info({ ...probe, mime: input.mimeType, strategy }, 'Video playback strategy');

		if (strategy === 'passthrough') {
			return {
				playback: null,
				playbackStatus: 'READY',
				playbackError: '',
				converted: false,
				strategy,
				probe,
			};
		}

		const outputPath = `${input.tmpPath}.playback.mp4`;
		if (strategy === 'remux') {
			try {
				await operations.remux(input.tmpPath, outputPath);
			} catch (err) {
				logger.warn({ err }, 'Playback remux failed, falling back to re-encode');
				await operations.remove(outputPath).catch((cleanupError) => {
					logger.warn({ err: cleanupError, outputPath }, 'Failed to remove partial remux output');
				});
				await operations.reencode(input.tmpPath, outputPath);
			}
		} else {
			await operations.reencode(input.tmpPath, outputPath);
		}

		const stat = await operations.stat(outputPath);
		logger.info({ strategy, sizeBytes: stat.size }, 'Video playback file created');

		return {
			playback: {
				tmpPath: outputPath,
				mimeType: 'video/mp4',
				ext: 'mp4',
				sizeBytes: stat.size,
			},
			playbackStatus: 'READY',
			playbackError: '',
			converted: true,
			strategy,
			probe,
		};
	} catch (err) {
		const message = errorMessage(err);
		logger.error({ err }, 'Video playback preparation failed');
		return {
			playback: null,
			playbackStatus: 'FAILED',
			playbackError: message.slice(0, 2000),
			converted: false,
			strategy: 'failed',
		};
	}
}
