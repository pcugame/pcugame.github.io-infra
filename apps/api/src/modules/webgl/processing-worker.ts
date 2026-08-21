import {
	WebglGenerationFencedError,
	WebglTerminalValidationError,
	type CanonicalWebglUploadSession,
	type WebglProcessingContext,
} from './processing.js';

export interface WebglProcessingWorkerRepository {
	claimVerifyingWebglSessions(input: {
		kind: 'WEBGL';
		claimToken: string;
		leaseUntil: Date;
		limit: number;
	}): Promise<CanonicalWebglUploadSession[]>;
	assertValidationLease(input: {
		sessionId: string;
		generation: number;
		claimToken: string;
	}): Promise<void>;
	renewValidationLease(input: {
		sessionId: string;
		generation: number;
		claimToken: string;
		leaseUntil: Date;
	}): Promise<boolean>;
	releaseValidationLease(input: {
		sessionId: string;
		generation: number;
		claimToken: string;
		error: string;
	}): Promise<void>;
	rejectInvalidSource(input: {
		sessionId: string;
		generation: number;
		claimToken: string;
		error: string;
	}): Promise<void>;
}

export interface WebglProcessingWorkerOptions {
	concurrency: number;
	leaseMs: number;
	heartbeatMs: number;
}

export interface WebglProcessingPassResult {
	claimed: number;
	ready: number;
	rejected: number;
	retried: number;
}

function validateOptions(options: WebglProcessingWorkerOptions): void {
	if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 16) {
		throw new RangeError('WebGL worker concurrency must be between 1 and 16');
	}
	if (!Number.isInteger(options.leaseMs) || options.leaseMs < 30_000) {
		throw new RangeError('WebGL worker lease must be at least 30 seconds');
	}
	if (!Number.isInteger(options.heartbeatMs) || options.heartbeatMs < 1_000
		|| options.heartbeatMs >= options.leaseMs) {
		throw new RangeError('WebGL worker heartbeat must be shorter than its lease');
	}
}

function safeError(error: unknown): string {
	return error instanceof Error ? error.message.slice(0, 2_000) : 'Unknown WebGL processing error';
}

export function createWebglProcessingWorker(deps: {
	repository: WebglProcessingWorkerRepository;
	processor: {
		process(session: CanonicalWebglUploadSession, context: WebglProcessingContext): Promise<unknown>;
	};
	ids: { next(): string };
	clock: { now(): Date };
	options: WebglProcessingWorkerOptions;
	logger: { error(context: Record<string, unknown>, message: string): void };
}) {
	validateOptions(deps.options);

	async function processOne(
		session: CanonicalWebglUploadSession,
		claimToken: string,
		outerSignal?: AbortSignal,
	): Promise<'ready' | 'rejected' | 'retried'> {
		const leaseAbort = new AbortController();
		const signal = outerSignal
			? AbortSignal.any([outerSignal, leaseAbort.signal])
			: leaseAbort.signal;
		let heartbeatRunning = false;
		const heartbeat = setInterval(() => {
			if (heartbeatRunning || signal.aborted) return;
			heartbeatRunning = true;
			void deps.repository.renewValidationLease({
				sessionId: session.id,
				generation: session.generation,
				claimToken,
				leaseUntil: new Date(deps.clock.now().getTime() + deps.options.leaseMs),
			}).then((owned) => {
				if (!owned) leaseAbort.abort(new Error('WebGL validation lease was lost'));
			}).catch((error) => leaseAbort.abort(error)).finally(() => {
				heartbeatRunning = false;
			});
		}, deps.options.heartbeatMs);
		const context: WebglProcessingContext = {
			claimToken,
			signal,
			assertClaimOwned: () => deps.repository.assertValidationLease({
				sessionId: session.id,
				generation: session.generation,
				claimToken,
			}),
		};
		try {
			await deps.processor.process(session, context);
			return 'ready';
		} catch (error) {
			if (error instanceof WebglGenerationFencedError) return 'rejected';
			if (error instanceof WebglTerminalValidationError && !signal.aborted) {
				await context.assertClaimOwned();
				await deps.repository.rejectInvalidSource({
					sessionId: session.id,
					generation: session.generation,
					claimToken,
					error: safeError(error),
				});
				return 'rejected';
			}
			await deps.repository.releaseValidationLease({
				sessionId: session.id,
				generation: session.generation,
				claimToken,
				error: safeError(error),
			}).catch((releaseError) => {
				deps.logger.error(
					{ error: releaseError, sessionId: session.id },
					'Failed to release WebGL validation lease',
				);
			});
			return 'retried';
		} finally {
			clearInterval(heartbeat);
		}
	}

	return {
		async runPass(signal?: AbortSignal): Promise<WebglProcessingPassResult> {
			if (signal?.aborted) return { claimed: 0, ready: 0, rejected: 0, retried: 0 };
			const claimToken = deps.ids.next();
			const sessions = await deps.repository.claimVerifyingWebglSessions({
				kind: 'WEBGL',
				claimToken,
				leaseUntil: new Date(deps.clock.now().getTime() + deps.options.leaseMs),
				limit: deps.options.concurrency,
			});
			const outcomes = await Promise.all(
				sessions.map((session) => processOne(session, claimToken, signal)),
			);
			return {
				claimed: sessions.length,
				ready: outcomes.filter((outcome) => outcome === 'ready').length,
				rejected: outcomes.filter((outcome) => outcome === 'rejected').length,
				retried: outcomes.filter((outcome) => outcome === 'retried').length,
			};
		},
	};
}

export function createWebglProcessingWorkerLoop(deps: {
	runPass(signal: AbortSignal): Promise<unknown>;
	pollIntervalMs: number;
	logger: { error(context: Record<string, unknown>, message: string): void };
}) {
	if (!Number.isInteger(deps.pollIntervalMs) || deps.pollIntervalMs < 100) {
		throw new RangeError('WebGL worker poll interval must be at least 100ms');
	}
	const abort = new AbortController();
	let active: Promise<void> | undefined;
	let pending = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let closed = false;

	function wake(): Promise<void> {
		if (closed) return Promise.resolve();
		pending = true;
		if (active) return active;
		active = (async () => {
			try {
				do {
					pending = false;
					if (!abort.signal.aborted) await deps.runPass(abort.signal);
				} while (pending && !closed);
			} catch (error) {
				deps.logger.error({ error }, 'WebGL worker pass failed');
			} finally {
				active = undefined;
			}
		})();
		return active;
	}

	return {
		async start(): Promise<void> {
			if (closed) throw new Error('WebGL worker loop is closed');
			if (!timer) timer = setInterval(() => { void wake(); }, deps.pollIntervalMs);
			await wake();
		},
		wake,
		async close(): Promise<void> {
			closed = true;
			pending = false;
			if (timer) clearInterval(timer);
			abort.abort(new Error('WebGL worker is shutting down'));
			await active;
		},
		isRunning: () => active !== undefined,
	};
}
