export function createExportWorkerLoop(deps: {
	runPass(signal: AbortSignal): Promise<number>;
	pollIntervalMs: number;
	logger: { error(context: Record<string, unknown>, message: string): void };
}) {
	if (!Number.isInteger(deps.pollIntervalMs) || deps.pollIntervalMs < 100) {
		throw new RangeError('Export worker poll interval must be at least 100ms');
	}
	const controller = new AbortController();
	let timer: NodeJS.Timeout | undefined;
	let active: Promise<void> | undefined;
	let pending = false;
	let closed = false;
	const wake = (): Promise<void> => {
		pending = true;
		if (active) return active;
		if (closed) return Promise.resolve();
		active = (async () => {
			try {
				do {
					pending = false;
					if (controller.signal.aborted) break;
					const processed = await deps.runPass(controller.signal);
					if (processed > 0) pending = true;
				} while (pending && !closed);
			} catch (error) {
				deps.logger.error({ error }, 'Export worker pass failed');
			} finally {
				active = undefined;
			}
		})();
		return active;
	};
	return {
		async start(): Promise<void> {
			if (closed) throw new Error('Export worker loop is closed');
			timer ??= setInterval(() => { void wake(); }, deps.pollIntervalMs);
			await wake();
		},
		wake,
		async close(): Promise<void> {
			if (closed) return active;
			closed = true;
			pending = false;
			if (timer) clearInterval(timer);
			controller.abort(new Error('Export worker is shutting down'));
			await active;
		},
	};
}
