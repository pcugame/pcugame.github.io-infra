/**
 * Video processing pipeline — automatic MP4 conversion.
 *
 * 3-layer structure:
 *   1. Probe    — ffprobe로 코덱 분석
 *   2. Strategy — passthrough / remux / re-encode 결정
 *   3. Convert  — ffmpeg 실행
 */

import { promises as fsp } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../../../lib/logger.js';

const execFileAsync = promisify(execFile);

export interface VideoProcessingInput {
	tmpPath: string;
	mimeType: string;
	ext: string;
	sizeBytes: number;
}

export interface VideoProcessingResult {
	tmpPath: string;
	mimeType: string;
	ext: string;
	sizeBytes: number;
	converted: boolean;
}

/* ── Layer 1: Probe ──────────────────────────────────────── */

export interface ProbeResult {
	videoCodec: string;
	audioCodec: string;
}

export async function probeCodecs(filePath: string): Promise<ProbeResult> {
	const { stdout } = await execFileAsync('ffprobe', [
		'-v', 'error',
		'-select_streams', 'v:0',
		'-show_entries', 'stream=codec_name',
		'-of', 'csv=p=0',
		filePath,
	]);
	const videoCodec = stdout.trim().toLowerCase();

	let audioCodec = '';
	try {
		const { stdout: audioOut } = await execFileAsync('ffprobe', [
			'-v', 'error',
			'-select_streams', 'a:0',
			'-show_entries', 'stream=codec_name',
			'-of', 'csv=p=0',
			filePath,
		]);
		audioCodec = audioOut.trim().toLowerCase();
	} catch {
		// No audio stream
	}

	return { videoCodec, audioCodec };
}

/* ── Layer 2: Strategy ───────────────────────────────────── */

export type ConversionStrategy = 'passthrough' | 'remux' | 'reencode';

const MP4_COMPATIBLE_VIDEO = new Set(['h264', 'hevc', 'h265', 'mpeg4', 'vp9']);
const MP4_COMPATIBLE_AUDIO = new Set(['aac', 'mp3', 'opus', 'flac', '']);
const BROWSER_PLAYABLE_VIDEO = new Set(['h264']);
const BROWSER_PLAYABLE_AUDIO = new Set(['aac', 'mp3', '']);

export function decideStrategy(
	ext: string,
	probe: ProbeResult,
): ConversionStrategy {
	const { videoCodec, audioCodec } = probe;

	if (
		ext === 'mp4' &&
		BROWSER_PLAYABLE_VIDEO.has(videoCodec) &&
		BROWSER_PLAYABLE_AUDIO.has(audioCodec)
	) {
		return 'passthrough';
	}

	if (
		MP4_COMPATIBLE_VIDEO.has(videoCodec) &&
		MP4_COMPATIBLE_AUDIO.has(audioCodec)
	) {
		return 'remux';
	}

	return 'reencode';
}

/* ── Layer 3: Convert ────────────────────────────────────── */

async function remux(inputPath: string, outputPath: string): Promise<void> {
	await execFileAsync('ffmpeg', [
		'-i', inputPath,
		'-c', 'copy',
		'-movflags', '+faststart',
		'-y', outputPath,
	]);
}

async function reencode(inputPath: string, outputPath: string): Promise<void> {
	await execFileAsync('ffmpeg', [
		'-i', inputPath,
		'-c:v', 'libx264', '-crf', '18', '-preset', 'medium',
		'-c:a', 'aac', '-b:a', '192k',
		'-movflags', '+faststart',
		'-y', outputPath,
	], { timeout: 30 * 60 * 1000 });
}

/* ── Orchestrator ────────────────────────────────────────── */

export async function processVideo(
	input: VideoProcessingInput,
): Promise<VideoProcessingResult> {
	// 1. Probe
	const probe = await probeCodecs(input.tmpPath);
	logger().info({ ...probe, mime: input.mimeType }, 'Video probe result');

	// 2. Strategy
	const strategy = decideStrategy(input.ext, probe);
	logger().info({ strategy }, 'Video conversion strategy');

	if (strategy === 'passthrough') {
		return { ...input, converted: false };
	}

	// 3. Convert
	const outputPath = input.tmpPath + '.mp4';

	if (strategy === 'remux') {
		try {
			await remux(input.tmpPath, outputPath);
		} catch (err) {
			logger().warn({ err }, 'Remux failed, falling back to re-encode');
			await fsp.unlink(outputPath).catch(() => {});
			await reencode(input.tmpPath, outputPath);
		}
	} else {
		await reencode(input.tmpPath, outputPath);
	}

	const stat = await fsp.stat(outputPath);
	logger().info({ strategy, from: input.ext, sizeBytes: stat.size }, 'Video converted to mp4');

	return {
		tmpPath: outputPath,
		mimeType: 'video/mp4',
		ext: 'mp4',
		sizeBytes: stat.size,
		converted: true,
	};
}
