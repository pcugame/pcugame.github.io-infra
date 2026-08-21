import { spawn } from 'node:child_process';
import type { BoundedImageCommandRunner } from './ports.js';
import { ImageInfrastructureError, ImageRejectedError } from './errors.js';

function killGroup(child: ReturnType<typeof spawn>): void {
	if (child.pid && process.platform !== 'win32') {
		try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* process exited */ }
	}
	child.kill('SIGKILL');
}

export function createBoundedImageCommandRunner(): BoundedImageCommandRunner {
	return {
		run(input) {
			if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1
				|| !Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes < 1) {
				throw new ImageInfrastructureError('Invalid image command resource budget');
			}
			if (input.signal?.aborted) {
				throw input.signal.reason instanceof Error
					? input.signal.reason
					: new ImageInfrastructureError('PDF command aborted');
			}
			return new Promise((resolve, reject) => {
				const child = spawn(input.file, input.args, {
					detached: process.platform !== 'win32', shell: false, stdio: ['ignore', 'pipe', 'pipe'],
				});
				let stdout = Buffer.alloc(0);
				let stderr = Buffer.alloc(0);
				let settled = false;
				const finish = (error?: Error) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					input.signal?.removeEventListener('abort', abort);
					if (error) reject(error);
					else resolve({ stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') });
				};
				const overflow = () => {
					killGroup(child);
					finish(new ImageRejectedError('PDF command output exceeded its bound', 'RESOURCE_LIMIT'));
				};
				const append = (current: Buffer, chunk: Buffer) => {
					const next = Buffer.concat([current, chunk]);
					if (stdout.length + stderr.length + chunk.length > input.maxOutputBytes) overflow();
					return next.subarray(0, input.maxOutputBytes);
				};
				child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
				child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
				child.once('error', (error) => finish(new ImageInfrastructureError('PDF command could not start', { cause: error })));
				child.once('close', (code, signal) => {
					if (settled) return;
					if (code === 0) finish();
					else finish(new ImageRejectedError(`PDF command failed (${String(code ?? signal)})`, 'PDF_INVALID'));
				});
				const abort = () => { killGroup(child); finish(input.signal?.reason instanceof Error ? input.signal.reason : new ImageInfrastructureError('PDF command aborted')); };
				input.signal?.addEventListener('abort', abort, { once: true });
				const timer = setTimeout(() => {
					killGroup(child);
					finish(new ImageRejectedError('PDF rendering timed out', 'PDF_TIMEOUT'));
				}, input.timeoutMs);
				timer.unref();
			});
		},
	};
}
