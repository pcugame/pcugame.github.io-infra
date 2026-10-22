import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { createBoundedCommandRunner } from '../modules/video/command-runner.js';
import { createFfmpegVideoOperations } from '../modules/video/ffmpeg-operations.js';
import { DEFAULT_VIDEO_LIMITS, playbackProfiles, playbackRenditions, canRemuxVideo, isBrowserSafeVideo } from '../modules/video/policy.js';

it.each([
	[120, [1, 2, 4]], [120000 / 1001, [1, 2, 4]], [60000 / 1001, [1, 2]], [50, [1, 2]], [24, [1]],
])('selects unique half-rate profiles for %s', (rate, divisors) => {
	expect(playbackProfiles(rate as number).map(item => item.divisor)).toEqual(divisors);
});

it.each([
 [1920, 1080, ['native', 'cap60', 'cap30', 'native@720p', 'cap60@720p', 'cap30@720p']],
 [1280, 720, ['native', 'cap60', 'cap30']],
 [960, 540, ['native', 'cap60', 'cap30']],
 [1920, 800, ['native', 'cap60', 'cap30', 'native@720p', 'cap60@720p', 'cap30@720p']],
])('plans unique native/FPS/quality combinations for %sx%s', (width, height, keys) => {
 expect(playbackRenditions({ width: width as number, height: height as number, frameRate: 120 }, DEFAULT_VIDEO_LIMITS).map(r => r.key)).toEqual(keys);
});

describe.runIf(process.env['RUN_FFMPEG_TESTS'] === 'true')('real FFmpeg frame timing', () => {
	const runner = createBoundedCommandRunner();
	const operations = createFfmpegVideoOperations(runner, DEFAULT_VIDEO_LIMITS);
	const generate = (args: string[]) => runner.run({ file: 'ffmpeg', args: ['-nostdin', '-v', 'error', ...args], timeoutMs: 30_000, maxOutputBytes: 65536 });
	it.each(['24000/1001', '24', '30000/1001', '30', '60000/1001', '60', '120000/1001', '120', 'vfr'])('preserves %s source frames and timing, reduces from original without slowing playback', async rate => {
		const dir = await mkdtemp(join(tmpdir(), 'fps-preservation-'));
		try {
			const source = join(dir, 'source.mkv');
			await generate(['-f', 'lavfi', '-i', `testsrc2=size=160x90:rate=${rate === 'vfr' ? '120' : rate}:duration=1.2`,
				...(rate === 'vfr' ? ['-vf', "select='if(lt(t,0.6),not(mod(n,2)),not(mod(n,3)))'", '-fps_mode', 'vfr'] : []),
				'-c:v', 'ffv1', '-y', source]);
			const checksum = createHash('sha256').update(await readFile(source)).digest('hex');
			const probe = await operations.probe(source);
			for(const { profile, divisor } of playbackProfiles(Math.max(probe.frameRate, probe.nominalFrameRate ?? 0))) {
				const output = join(dir, `${profile}.mp4`);
				await operations.reencode(source, output, 10_000_000, undefined, divisor);
				await operations.verifyPlayback!(source, output, divisor);
				const result = await operations.probe(output);
				expect(result.width).toBe(160);
				expect(result.height).toBe(90);
				expect(result.fastStart).toBe(true);
				expect(Math.abs(result.durationSeconds - probe.durationSeconds)).toBeLessThan(0.15);
			}
			expect(createHash('sha256').update(await readFile(source)).digest('hex')).toBe(checksum);
		} finally { await rm(dir, { recursive: true, force: true }); }
	}, 90_000);
	it('generates a 720p rendition with the original fractional frame timing', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'video-quality-'));
		try {
			const source = join(dir, 'source.mkv'), output = join(dir, '720p.mp4');
			await generate(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=60000/1001:duration=0.4', '-c:v', 'ffv1', source]);
			await operations.reencode(source, output, 10_000_000, undefined, 1, '720p');
			await operations.verifyPlayback!(source, output, 1);
			expect(await operations.probe(output)).toMatchObject({ width: 1280, height: 720, fastStart: true });
		} finally { await rm(dir, { recursive: true, force: true }); }
	}, 60_000);
	it.each(['mov', 'mkv'])('remuxes compatible H.264 %s without re-encoding', async container => {
		const dir = await mkdtemp(join(tmpdir(), 'video-remux-'));
		try {
			const source = join(dir, `source.${container}`), output = join(dir, 'output.mp4');
			await generate(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=60000/1001:duration=1.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(container === 'mov' ? ['-movflags', '+faststart'] : []), source]);
			const probe = await operations.probe(source);
			expect(isBrowserSafeVideo(probe, DEFAULT_VIDEO_LIMITS)).toBe(false);
			expect(canRemuxVideo(probe, DEFAULT_VIDEO_LIMITS)).toBe(true);
			await operations.remux(source, output, 10000000);
			await operations.verifyPlayback!(source, output, 1);
			expect(isBrowserSafeVideo(await operations.probe(output), DEFAULT_VIDEO_LIMITS)).toBe(true);
		} finally { await rm(dir, { recursive: true, force: true }); }
	}, 60000);
	it('rejects a fully decodable but truncated playback', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'fps-truncation-'));
		try {
			const source = join(dir, 'source.mp4'); const output = join(dir, 'output.mp4');
			await generate(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=2', '-c:v', 'libx264', '-y', source]);
			await generate(['-i', source, '-t', '0.5', '-c', 'copy', '-y', output]);
			await expect(operations.verifyPlayback!(source, output, 1)).rejects.toThrow(/frame count|duration/);
		} finally { await rm(dir, { recursive: true, force: true }); }
	});
});
