import { open, stat } from 'node:fs/promises';
import type { BoundedCommandRunner, VideoOperations, VideoProbe } from './ports.js';
import type { VideoLimits } from './policy.js';
import { VideoInfrastructureError, VideoRejectedError } from './errors.js';

interface ProbeJson {
	streams?: Array<{
		codec_type?: string;
		codec_name?: string;
		pix_fmt?: string;
		width?: number;
		height?: number;
		avg_frame_rate?: string;
		r_frame_rate?: string;
		bit_rate?: string;
	}>;
	format?: {
		format_name?: string;
		bit_rate?: string;
		duration?: string;
	};
}

function ratio(value: string | undefined): number {
	if (!value || value === '0/0') return 0;
	const [numerator, denominator = '1'] = value.split('/');
	const top = Number(numerator);
	const bottom = Number(denominator);
	return Number.isFinite(top) && Number.isFinite(bottom) && bottom !== 0 ? top / bottom : 0;
}

function finiteNumber(value: unknown, fallback = 0): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

async function hasFastStart(filePath: string): Promise<boolean> {
	const metadata = await stat(filePath);
	const handle = await open(filePath, 'r');
	try {
		let offset = 0;
		while (offset + 8 <= metadata.size) {
			const buffer = Buffer.alloc(16);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
			if (bytesRead < 8) return false;
			let atomSize = buffer.readUInt32BE(0);
			const atomType = buffer.subarray(4, 8).toString('ascii');
			let headerSize = 8;
			if (atomSize === 1) {
				if (bytesRead < 16) return false;
				const large = buffer.readBigUInt64BE(8);
				if (large > BigInt(Number.MAX_SAFE_INTEGER)) return false;
				atomSize = Number(large);
				headerSize = 16;
			} else if (atomSize === 0) atomSize = metadata.size - offset;
			if (atomType === 'moov') return true;
			if (atomType === 'mdat') return false;
			if (atomSize < headerSize || offset + atomSize > metadata.size) return false;
			offset += atomSize;
		}
		return false;
	} finally {
		await handle.close();
	}
}

function parseProbe(stdout: string): Omit<VideoProbe, 'fastStart'> {
	let parsed: ProbeJson;
	try {
		parsed = JSON.parse(stdout) as ProbeJson;
	} catch (error) {
		throw new VideoRejectedError('ffprobe returned malformed JSON', 'CONTAINER_INVALID', { cause: error });
	}
	const streams = parsed.streams ?? [];
	const videos = streams.filter((stream) => stream.codec_type === 'video');
	const audios = streams.filter((stream) => stream.codec_type === 'audio');
	const video = videos[0];
	if (!video?.codec_name) {
		throw new VideoRejectedError('No decodable video stream found', 'CONTAINER_INVALID');
	}
	return {
		formatNames: (parsed.format?.format_name ?? '')
			.toLowerCase().split(',').map((name) => name.trim()).filter(Boolean),
		videoCodec: video.codec_name.toLowerCase(),
		audioCodec: (audios[0]?.codec_name ?? '').toLowerCase(),
		pixelFormat: (video.pix_fmt ?? '').toLowerCase(),
		width: finiteNumber(video.width),
		height: finiteNumber(video.height),
		frameRate: ratio(video.avg_frame_rate) || ratio(video.r_frame_rate),
		bitRate: finiteNumber(parsed.format?.bit_rate ?? video.bit_rate),
		durationSeconds: finiteNumber(parsed.format?.duration),
		streamCount: streams.length,
		videoStreamCount: videos.length,
		audioStreamCount: audios.length,
	};
}

function rejectedCommand(message: string, error: unknown, signal?: AbortSignal): Error {
	if (signal?.aborted) {
		return signal.reason instanceof Error ? signal.reason : new VideoInfrastructureError('Video command aborted');
	}
	if (error instanceof VideoRejectedError || error instanceof VideoInfrastructureError) return error;
	return new VideoRejectedError(message, 'CORRUPT_MEDIA', { cause: error });
}

/** Worker-only ffprobe/ffmpeg adapter with fixed binaries and argv arrays. */
export function createFfmpegVideoOperations(
	runner: BoundedCommandRunner,
	limits: VideoLimits,
): VideoOperations {
	const probeCommon = ['-v', 'error'] as const;
	const ffmpegCommon = ['-nostdin', '-v', 'error'] as const;
	return {
		async probe(filePath, signal) {
			try {
				const result = await runner.run({
					file: 'ffprobe',
					args: [
						...probeCommon,
						'-show_entries',
						'format=format_name,bit_rate,duration:stream=codec_type,codec_name,pix_fmt,width,height,avg_frame_rate,r_frame_rate,bit_rate',
						'-of', 'json',
						filePath,
					],
					timeoutMs: limits.probeTimeoutMs,
					maxOutputBytes: limits.commandOutputBytes,
					signal,
				});
				const probe = parseProbe(result.stdout);
				return {
					...probe,
					fastStart: probe.formatNames.includes('mp4') || probe.formatNames.includes('mov')
						? await hasFastStart(filePath)
						: false,
				};
			} catch (error) {
				throw rejectedCommand('Video container probe failed', error, signal);
			}
		},
		async verifyDecode(filePath, signal) {
			try {
				await runner.run({
					file: 'ffmpeg',
					args: [...ffmpegCommon, '-xerror', '-i', filePath, '-map', '0:v:0', '-map', '0:a:0?', '-f', 'null', '-'],
					timeoutMs: limits.decodeTimeoutMs,
					maxOutputBytes: limits.commandOutputBytes,
					signal,
				});
			} catch (error) {
				throw rejectedCommand('Video decode validation failed', error, signal);
			}
		},
		async remux(inputPath, outputPath, maxOutputBytes, signal) {
			try {
				await runner.run({
					file: 'ffmpeg',
					args: [
						...ffmpegCommon, '-xerror', '-i', inputPath,
						'-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy',
						'-movflags', '+faststart', '-fs', String(maxOutputBytes), '-y', outputPath,
					],
					timeoutMs: limits.transcodeTimeoutMs,
					maxOutputBytes: limits.commandOutputBytes,
					signal,
				});
			} catch (error) {
				throw rejectedCommand('Video remux failed', error, signal);
			}
		},
		async reencode(inputPath, outputPath, maxOutputBytes, signal) {
			try {
				await runner.run({
					file: 'ffmpeg',
					args: [
						...ffmpegCommon, '-xerror', '-i', inputPath,
						'-map', '0:v:0', '-map', '0:a:0?',
						'-vf', `scale=${limits.maxPlaybackWidth}:${limits.maxPlaybackHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=${limits.maxPlaybackFrameRate}`,
						'-c:v', 'libx264', '-preset', 'medium', '-b:v', '4800k',
						'-maxrate', '5000k', '-bufsize', '10000k', '-pix_fmt', 'yuv420p',
						'-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
						'-fs', String(maxOutputBytes), '-y', outputPath,
					],
					timeoutMs: limits.transcodeTimeoutMs,
					maxOutputBytes: limits.commandOutputBytes,
					signal,
				});
			} catch (error) {
				throw rejectedCommand('Video transcode failed', error, signal);
			}
		},
	};
}

export const videoProbeInternals = { parseProbe };
