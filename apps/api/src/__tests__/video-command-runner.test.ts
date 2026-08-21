import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createBoundedCommandRunner } from '../modules/video/command-runner.js';
import { createFfmpegVideoOperations } from '../modules/video/ffmpeg-operations.js';
import { DEFAULT_VIDEO_LIMITS } from '../modules/video/policy.js';
import { VideoRejectedError } from '../modules/video/errors.js';
import type { BoundedCommandRunner } from '../modules/video/ports.js';

describe('bounded VIDEO command execution', () => {
	it('kills a timed-out process group', async () => {
		const runner = createBoundedCommandRunner();
		await expect(runner.run({
			file: process.execPath,
			args: ['-e', 'setInterval(() => {}, 1000)'],
			timeoutMs: 30,
			maxOutputBytes: 1_024,
		})).rejects.toMatchObject({
			name: 'VideoRejectedError',
			code: 'PROCESS_TIMEOUT',
		});
	});

	it('kills a process whose output exceeds the capture budget', async () => {
		const runner = createBoundedCommandRunner();
		await expect(runner.run({
			file: process.execPath,
			args: ['-e', "process.stdout.write('x'.repeat(10000))"],
			timeoutMs: 2_000,
			maxOutputBytes: 128,
		})).rejects.toMatchObject({
			name: 'VideoRejectedError',
			code: 'PROCESS_OUTPUT_LIMIT',
		});
	});

	it('passes hostile-looking file names as one argv value with fixed binaries', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'video-argv-test-'));
		const filePath = path.join(root, 'source;touch injected.mp4');
		const atom = Buffer.alloc(24);
		atom.writeUInt32BE(12, 0);
		atom.write('ftyp', 4, 'ascii');
		atom.writeUInt32BE(12, 12);
		atom.write('moov', 16, 'ascii');
		await writeFile(filePath, atom);
		const run = vi.fn(async (_input: Parameters<BoundedCommandRunner['run']>[0]) => ({
			stdout: JSON.stringify({
				streams: [{
					codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p',
					width: 640, height: 360, avg_frame_rate: '30/1', bit_rate: '1000000',
				}],
				format: { format_name: 'mov,mp4', bit_rate: '1000000', duration: '5' },
			}),
			stderr: '',
		}));
		try {
			const operations = createFfmpegVideoOperations({ run }, DEFAULT_VIDEO_LIMITS);
			await expect(operations.probe(filePath)).resolves.toMatchObject({
				videoCodec: 'h264',
				fastStart: true,
			});
			expect(run).toHaveBeenCalledWith(expect.objectContaining({
				file: 'ffprobe',
				args: expect.arrayContaining([filePath]),
			}));
			const args = run.mock.calls[0]![0].args;
			expect(args.filter((value) => value === filePath)).toHaveLength(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('keeps bounded process failures distinguishable from generic errors', () => {
		expect(new VideoRejectedError('timeout', 'PROCESS_TIMEOUT')).toMatchObject({
			name: 'VideoRejectedError',
			code: 'PROCESS_TIMEOUT',
		});
	});
});
