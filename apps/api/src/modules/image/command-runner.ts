import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import type { BoundedImageCommandRunner } from './ports.js';
import { ImageInfrastructureError, ImageRejectedError } from './errors.js';
import { AggregateOutputBudget, writeBoundedOutput } from './output-budget.js';

function killGroup(child: ReturnType<typeof spawn>): void {
	if (child.pid && process.platform !== 'win32') {
		try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* process exited */ }
	}
	child.kill('SIGKILL');
}

export function createBoundedImageCommandRunner(): BoundedImageCommandRunner {
	return {
		async run(input) {
			if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1
				|| !Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes < 1
				|| (input.stdoutFile && (!Number.isSafeInteger(input.stdoutFile.maxBytes)
					|| input.stdoutFile.maxBytes < 1))) {
				throw new ImageInfrastructureError('Invalid image command resource budget');
			}
			if (input.signal?.aborted) {
				throw input.signal.reason instanceof Error
					? input.signal.reason
					: new ImageInfrastructureError('PDF command aborted');
			}
			let child: ReturnType<typeof spawn>;
			try {
				child = spawn(input.file, input.args, {
					detached: process.platform !== 'win32', shell: false, stdio: ['ignore', 'pipe', 'pipe'],
				});
			} catch (error) {
				throw new ImageInfrastructureError('PDF command could not start', { cause: error });
			}
			if (!child.stdout || !child.stderr) {
				killGroup(child);
				throw new ImageInfrastructureError('PDF command did not expose bounded output pipes');
			}
			const childStdout = child.stdout;
			const childStderr = child.stderr;
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			let diagnosticBytes = 0;
			let forcedError: Error | undefined;
			const force = (error: Error) => {
				if (forcedError) return;
				forcedError = error;
				killGroup(child);
			};
			const capture = (chunks: Buffer[]) => (raw: Buffer | string) => {
				const chunk = Buffer.from(raw);
				if (chunk.length > input.maxOutputBytes - diagnosticBytes) {
					force(new ImageRejectedError('PDF command diagnostic output exceeded its bound', 'RESOURCE_LIMIT'));
					return;
				}
				diagnosticBytes += chunk.length;
				chunks.push(chunk);
			};
			if (!input.stdoutFile) childStdout.on('data', capture(stdout));
			childStderr.on('data', capture(stderr));
			const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
				child.once('error', (error) => reject(new ImageInfrastructureError('PDF command could not start', { cause: error })));
				child.once('close', (code, signal) => resolve({ code, signal }));
			});
			let stdoutFileCreated = false;
			const stdoutWrite = input.stdoutFile
				? writeBoundedOutput({
					source: childStdout,
					destination: input.stdoutFile.path,
					fileLimitBytes: input.stdoutFile.maxBytes,
					aggregateBudget: new AggregateOutputBudget(input.stdoutFile.maxBytes),
					onCreate: () => { stdoutFileCreated = true; },
					...(input.signal ? { signal: input.signal } : {}),
				}).catch((error: unknown) => {
					force(error instanceof Error ? error : new ImageInfrastructureError('PDF output write failed'));
					throw error;
				})
				: Promise.resolve(0);
			const abort = () => force(input.signal?.reason instanceof Error
				? input.signal.reason : new ImageInfrastructureError('PDF command aborted'));
			input.signal?.addEventListener('abort', abort, { once: true });
			const timer = setTimeout(() => force(new ImageRejectedError('PDF rendering timed out', 'PDF_TIMEOUT')), input.timeoutMs);
			timer.unref();
			try {
				const [result] = await Promise.all([exited, stdoutWrite]);
				if (forcedError) throw forcedError;
				if (result.code !== 0) {
					throw new ImageRejectedError(`PDF command failed (${String(result.code ?? result.signal)})`, 'PDF_INVALID');
				}
				return { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
			} catch (error) {
				force(error instanceof Error ? error : new ImageInfrastructureError('PDF command failed'));
				await Promise.allSettled([exited, stdoutWrite]);
				if (input.stdoutFile && stdoutFileCreated) {
					await rm(input.stdoutFile.path, { force: true }).catch(() => undefined);
				}
				throw forcedError;
			} finally {
				clearTimeout(timer);
				input.signal?.removeEventListener('abort', abort);
			}
		},
	};
}
