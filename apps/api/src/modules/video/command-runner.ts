import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { BoundedCommandRunner } from './ports.js';
import { VideoInfrastructureError, VideoRejectedError } from './errors.js';

type SpawnedVideoCommand = ChildProcess & { stdout: Readable; stderr: Readable };

type SpawnProcess = (
	file: string,
	args: readonly string[],
) => SpawnedVideoCommand;

function nodeSpawn(file: string, args: readonly string[]): SpawnedVideoCommand {
	return spawn(file, args, {
		detached: process.platform !== 'win32',
		shell: false,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
}

function terminate(child: SpawnedVideoCommand): void {
	if (child.pid && process.platform !== 'win32') {
		try {
			process.kill(-child.pid, 'SIGKILL');
			return;
		} catch {
			// Fall back to the direct child when process-group termination races exit.
		}
	}
	child.kill('SIGKILL');
}

/** Executes a fixed binary with an argv array; shell parsing is never enabled. */
export function createBoundedCommandRunner(
	spawnProcess: SpawnProcess = nodeSpawn,
): BoundedCommandRunner {
	return {
		run(input) {
			if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1
				|| !Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes < 1) {
				return Promise.reject(new VideoInfrastructureError('Invalid command resource budget'));
			}
			if (input.signal?.aborted) {
				return Promise.reject(input.signal.reason ?? new VideoInfrastructureError('Video command aborted'));
			}

			return new Promise((resolve, reject) => {
				let child: SpawnedVideoCommand;
				try {
					child = spawnProcess(input.file, [...input.args]);
				} catch (error) {
					reject(new VideoInfrastructureError(`Could not start ${input.file}`, { cause: error }));
					return;
				}
				const stdout: Buffer[] = [];
				const stderr: Buffer[] = [];
				let outputBytes = 0;
				let settled = false;
				let forcedError: unknown;

				const finish = (error?: unknown) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					input.signal?.removeEventListener('abort', onAbort);
					if (error) reject(error);
					else resolve({
						stdout: Buffer.concat(stdout).toString('utf8'),
						stderr: Buffer.concat(stderr).toString('utf8'),
					});
				};
				const force = (error: unknown) => {
					if (forcedError || settled) return;
					forcedError = error;
					terminate(child);
				};
				const capture = (chunks: Buffer[]) => (raw: Buffer | string) => {
					const chunk = Buffer.from(raw);
					outputBytes += chunk.length;
					if (outputBytes > input.maxOutputBytes) {
						force(new VideoRejectedError(
							`${input.file} output exceeded its bounded capture limit`,
							'PROCESS_OUTPUT_LIMIT',
						));
						return;
					}
					chunks.push(chunk);
				};
				const onAbort = () => force(input.signal?.reason ?? new VideoInfrastructureError('Video command aborted'));
				const timer = setTimeout(() => force(new VideoRejectedError(
					`${input.file} exceeded its processing timeout`,
					'PROCESS_TIMEOUT',
				)), input.timeoutMs);
				timer.unref();
				input.signal?.addEventListener('abort', onAbort, { once: true });
				child.stdout.on('data', capture(stdout));
				child.stderr.on('data', capture(stderr));
				child.once('error', (error) => finish(
					forcedError ?? new VideoInfrastructureError(`${input.file} process failed`, { cause: error }),
				));
				child.once('close', (code, signal) => {
					if (forcedError) {
						finish(forcedError);
						return;
					}
					if (code !== 0) {
						finish(new Error(
							`${input.file} exited with code ${String(code)} signal ${String(signal)}: ${Buffer.concat(stderr).toString('utf8').slice(0, 1_000)}`,
						));
						return;
					}
					finish();
				});
			});
		},
	};
}
