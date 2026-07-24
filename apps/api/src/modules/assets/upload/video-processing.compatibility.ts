import { execFile } from 'node:child_process';
import { promises as nodeFileSystem } from 'node:fs';
import { promisify } from 'node:util';
import type { FileSystem } from '../../../application/ports.js';
import type {
	ProbeResult,
	VideoProcessingOperations,
} from './video-processing.js';

const execFileAsync = promisify(execFile);
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1080;
const MAX_FRAME_RATE = 30;
const TARGET_VIDEO_BITRATE = '4800k';
const AUDIO_BITRATE = '160k';

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

type VideoFileSystem = Pick<FileSystem, 'readRange' | 'remove' | 'stat'>;

function parseFrameRate(value?: string): number {
	if (!value || value === '0/0') return 0;
	const [numRaw, denRaw] = value.split('/');
	const num = Number(numRaw);
	const den = denRaw ? Number(denRaw) : 1;
	if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
	return num / den;
}

async function hasFastStart(
	fileSystem: VideoFileSystem,
	filePath: string,
): Promise<boolean> {
	const stat = await fileSystem.stat(filePath);
	let offset = 0;
	while (offset + 8 <= stat.size) {
		const header = await fileSystem.readRange(filePath, offset, offset + 15);
		if (header.length < 8) return false;

		let atomSize = header.readUInt32BE(0);
		const atomType = header.subarray(4, 8).toString('ascii');
		let headerSize = 8;
		if (atomSize === 1) {
			if (header.length < 16) return false;
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
}

export function createNodeVideoProcessingOperations(
	fileSystem: VideoFileSystem,
): VideoProcessingOperations {
	return {
		async probe(filePath): Promise<ProbeResult> {
			const { stdout } = await execFileAsync('ffprobe', [
				'-v', 'error',
				'-show_entries',
				'format=format_name,bit_rate:stream=codec_type,codec_name,pix_fmt,width,height,r_frame_rate,avg_frame_rate,bit_rate',
				'-of', 'json',
				filePath,
			]);
			const parsed = JSON.parse(stdout) as FfprobeJson;
			const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
			if (!video?.codec_name) throw new Error('No video stream found');
			const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio');
			const frameRate = parseFrameRate(video.avg_frame_rate)
				|| parseFrameRate(video.r_frame_rate);
			const formatName = (parsed.format?.format_name ?? '').toLowerCase();
			const bitRate = Number(parsed.format?.bit_rate ?? video.bit_rate ?? 0) || 0;
			const fastStart = formatName.split(',').includes('mp4')
				|| formatName.split(',').includes('mov')
				? await hasFastStart(fileSystem, filePath)
				: false;
			return {
				formatName,
				videoCodec: video.codec_name.toLowerCase(),
				audioCodec: (audio?.codec_name ?? '').toLowerCase(),
				pixelFormat: (video.pix_fmt ?? '').toLowerCase(),
				width: video.width ?? 0,
				height: video.height ?? 0,
				frameRate,
				bitRate,
				fastStart,
			};
		},
		async remux(inputPath, outputPath) {
			await execFileAsync('ffmpeg', [
				'-i', inputPath,
				'-map', '0:v:0',
				'-map', '0:a:0?',
				'-c', 'copy',
				'-movflags', '+faststart',
				'-y', outputPath,
			]);
		},
		async reencode(inputPath, outputPath) {
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
		},
		remove: (filePath) => fileSystem.remove(filePath),
		stat: (filePath) => fileSystem.stat(filePath),
	};
}

const compatibilityFileSystem: VideoFileSystem = {
	async stat(path) {
		return nodeFileSystem.stat(path);
	},
	async remove(path) {
		await nodeFileSystem.unlink(path);
	},
	async readRange(path, start, end) {
		const handle = await nodeFileSystem.open(path, 'r');
		try {
			const buffer = Buffer.alloc(end - start + 1);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
			return buffer.subarray(0, bytesRead);
		} finally {
			await handle.close();
		}
	},
};

export const nodeVideoProcessingOperations =
	createNodeVideoProcessingOperations(compatibilityFileSystem);
