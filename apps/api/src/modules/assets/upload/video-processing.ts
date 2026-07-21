/**
 * Video playback preparation.
 *
 * The original upload is preserved. This module only decides whether that
 * original is already smooth enough for browser playback, or creates a
 * separate playback MP4 when needed.
 */

import { promises as fsp } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../../../lib/logger.js';

const execFileAsync = promisify(execFile);

const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1080;
const MAX_FRAME_RATE = 30;
const TARGET_VIDEO_BITRATE = '4800k';
const MAX_TOTAL_BITRATE = 5_500_000;
const AUDIO_BITRATE = '160k';

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

interface FfprobeJson {
	streams?: {
		codec_type?: string;
		codec_name?: string;
		pix_fmt?: string;
		width?: number;
		height?: number;
		r_frame_rate?: string;
		avg_frame_rate?: string;
		bit_rate?: string;
	}[];
	format?: {
		format_name?: string;
		bit_rate?: string;
	};
}

function parseFrameRate(value?: string): number {
	if (!value || value === '0/0') return 0;
	const [numRaw, denRaw] = value.split('/');
	const num = Number(numRaw);
	const den = denRaw ? Number(denRaw) : 1;
	if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
	return num / den;
}

function normalizeExt(ext: string): string {
	return ext.replace(/^\./, '').toLowerCase();
}

async function hasFastStart(filePath: string): Promise<boolean> {
	const handle = await fsp.open(filePath, 'r');
	try {
		const stat = await handle.stat();
		let offset = 0;
		const header = Buffer.alloc(16);

		while (offset + 8 <= stat.size) {
			const { bytesRead } = await handle.read(header, 0, 16, offset);
			if (bytesRead < 8) return false;

			let atomSize = header.readUInt32BE(0);
			const atomType = header.subarray(4, 8).toString('ascii');
			let headerSize = 8;

			if (atomSize === 1) {
				if (bytesRead < 16) return false;
				const largeSize = header.readBigUInt64BE(8);
				if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) return false;
				atomSize = Number(largeSize);
				headerSize = 16;
			} else if (atomSize === 0) {
				atomSize = stat.size - offset;
			}

			if (atomType === 'moov') return true;
			if (atomType === 'mdat') return false;
			if (atomSize < headerSize) return false;
			offset += atomSize;
		}

		return false;
	} finally {
		await handle.close();
	}
}

export async function probeVideo(filePath: string): Promise<ProbeResult> {
	const { stdout } = await execFileAsync('ffprobe', [
		'-v', 'error',
		'-show_entries',
		'format=format_name,bit_rate:stream=codec_type,codec_name,pix_fmt,width,height,r_frame_rate,avg_frame_rate,bit_rate',
		'-of', 'json',
		filePath,
	]);

	const parsed = JSON.parse(stdout) as FfprobeJson;
	const video = parsed.streams?.find((s) => s.codec_type === 'video');
	if (!video?.codec_name) throw new Error('No video stream found');

	const audio = parsed.streams?.find((s) => s.codec_type === 'audio');
	const frameRate = parseFrameRate(video.avg_frame_rate) || parseFrameRate(video.r_frame_rate);
	const formatName = (parsed.format?.format_name ?? '').toLowerCase();
	const bitRate = Number(parsed.format?.bit_rate ?? video.bit_rate ?? 0) || 0;
	const fastStart = formatName.split(',').includes('mp4') || formatName.split(',').includes('mov')
		? await hasFastStart(filePath)
		: false;

	return {
		formatName,
		videoCodec: (video.codec_name ?? '').toLowerCase(),
		audioCodec: (audio?.codec_name ?? '').toLowerCase(),
		pixelFormat: (video.pix_fmt ?? '').toLowerCase(),
		width: video.width ?? 0,
		height: video.height ?? 0,
		frameRate,
		bitRate,
		fastStart,
	};
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

async function remux(inputPath: string, outputPath: string): Promise<void> {
	await execFileAsync('ffmpeg', [
		'-i', inputPath,
		'-map', '0:v:0',
		'-map', '0:a:0?',
		'-c', 'copy',
		'-movflags', '+faststart',
		'-y', outputPath,
	]);
}

async function reencode(inputPath: string, outputPath: string): Promise<void> {
	await execFileAsync('ffmpeg', [
		'-i', inputPath,
		'-map', '0:v:0',
		'-map', '0:a:0?',
		'-vf', `scale=${MAX_WIDTH}:${MAX_HEIGHT}:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=fps='min(${MAX_FRAME_RATE},source_fps)':round=down`,
		'-c:v', 'libx264',
		'-preset', 'medium',
		'-b:v', TARGET_VIDEO_BITRATE,
		'-maxrate', '5000k',
		'-bufsize', '10000k',
		'-pix_fmt', 'yuv420p',
		'-c:a', 'aac',
		'-b:a', AUDIO_BITRATE,
		'-movflags', '+faststart',
		'-y', outputPath,
	], { timeout: 30 * 60 * 1000 });
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export async function processVideo(
	input: VideoProcessingInput,
): Promise<VideoProcessingResult> {
	try {
		const probe = await probeVideo(input.tmpPath);
		const strategy = decideStrategy(input.ext, probe);
		logger().info({ ...probe, mime: input.mimeType, strategy }, 'Video playback strategy');

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
				await remux(input.tmpPath, outputPath);
				} catch (err) {
					logger().warn({ err }, 'Playback remux failed, falling back to re-encode');
					await fsp.unlink(outputPath).catch((cleanupError) => {
						logger().warn({ err: cleanupError, outputPath }, 'Failed to remove partial remux output');
					});
					await reencode(input.tmpPath, outputPath);
			}
		} else {
			await reencode(input.tmpPath, outputPath);
		}

		const stat = await fsp.stat(outputPath);
		logger().info({ strategy, sizeBytes: stat.size }, 'Video playback file created');

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
		logger().error({ err }, 'Video playback preparation failed');
		return {
			playback: null,
			playbackStatus: 'FAILED',
			playbackError: message.slice(0, 2000),
			converted: false,
			strategy: 'failed',
		};
	}
}
