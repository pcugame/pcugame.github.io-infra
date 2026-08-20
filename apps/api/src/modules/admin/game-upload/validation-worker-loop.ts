import { safeGameUploadLogContext } from './observability.js';

export interface ValidationWorkerLoop {
	start(): Promise<void>;
	wake(): Promise<void>;
	close(): Promise<void>;
	isRunning(): boolean;
}

/**
 * Process-local single-flight polling. A wake arriving during an active pass is
 * represented by one boolean and therefore causes at most one follow-up pass.
 * The active promise remains installed until every coalesced pass has ended.
 */
export function createValidationWorkerLoop(deps: {
	runPass(signal: AbortSignal): Promise<unknown>;
	pollIntervalMs: number;
	logger: { error(context: Record<string, unknown>, message: string): void };
	scheduleEvery?: (intervalMs: number, task: () => void) => { cancel(): void };
}): ValidationWorkerLoop {
	if (!Number.isInteger(deps.pollIntervalMs) || deps.pollIntervalMs < 100) {
		throw new RangeError('Validation worker poll interval must be at least 100ms');
	}
	const abortController = new AbortController();
	let started = false;
	let closing = false;
	let pending = false;
	let active: Promise<void> | undefined;
	let timer: { cancel(): void } | undefined;

	const scheduleEvery = deps.scheduleEvery ?? ((intervalMs, task) => {
		const handle = setInterval(task, intervalMs);
		return { cancel: () => clearInterval(handle) };
	});

	function ensurePass(): Promise<void> {
		pending = true;
		if (active) return active;
		if (closing) return Promise.resolve();
		active = (async () => {
			try {
				do {
					pending = false;
					if (abortController.signal.aborted) return;
					await deps.runPass(abortController.signal);
				} while (pending && !closing);
			} catch (error) {
				pending = false;
				deps.logger.error(
					safeGameUploadLogContext({ error, action: 'worker_pass', result: 'failed' }),
					'Validation worker pass failed',
				);
			} finally {
				active = undefined;
			}
		})();
		return active;
	}

	return {
		async start() {
			if (started) return active;
			if (closing) throw new Error('Validation worker loop is closed');
			started = true;
			timer = scheduleEvery(deps.pollIntervalMs, () => { void ensurePass(); });
			await ensurePass();
		},
		wake: ensurePass,
		async close() {
			if (closing) return active;
			closing = true;
			pending = false;
			timer?.cancel();
			abortController.abort(new Error('Validation worker is shutting down'));
			await active;
		},
		isRunning: () => active !== undefined,
	};
}
