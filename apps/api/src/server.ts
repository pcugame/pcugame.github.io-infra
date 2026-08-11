import { pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Env } from './config/env.js';
import type { BackendContext } from './backend-context.js';

export interface SignalBoundary {
	once(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
	off(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
}

export interface ServerRuntime {
	start(): Promise<void>;
	shutdown(reason: string): Promise<0 | 1>;
}

class ShutdownDeadlineError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ShutdownDeadlineError';
	}
}

/**
 * Own signal registration and startup/shutdown overlap without owning resources
 * itself. Fastify's onClose hook and every failure path converge on the same
 * idempotent BackendContext.close() promise.
 */
export function createServerRuntime(deps: {
	config: Env;
	context: BackendContext;
	app: FastifyInstance;
	signals?: SignalBoundary;
	setExitCode?: (code: number) => void;
	forceExit?: (code: number) => void;
}): ServerRuntime {
	const { config, context, app } = deps;
	const signals = deps.signals ?? process;
	const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
	const forceExit = deps.forceExit ?? ((code: number) => process.exit(code));
	let signalHandlersRegistered = false;
	let startPromise: Promise<void> | undefined;
	let shutdownPromise: Promise<0 | 1> | undefined;

	const onSigterm = () => {
		void shutdown('SIGTERM').then(setExitCode, () => setExitCode(1));
	};
	const onSigint = () => {
		void shutdown('SIGINT').then(setExitCode, () => setExitCode(1));
	};

	function registerSignalHandlers(): void {
		if (signalHandlersRegistered) return;
		signalHandlersRegistered = true;
		signals.once('SIGTERM', onSigterm);
		signals.once('SIGINT', onSigint);
	}

	function removeSignalHandlers(): void {
		if (!signalHandlersRegistered) return;
		signalHandlersRegistered = false;
		signals.off('SIGTERM', onSigterm);
		signals.off('SIGINT', onSigint);
	}

	async function closePreserving(error: unknown): Promise<never> {
		removeSignalHandlers();
		await app.close().catch(() => undefined);
		await context.close().catch(() => undefined);
		throw error;
	}

	async function finishShutdownIfRequested(): Promise<boolean> {
		const pending = shutdownPromise;
		if (!pending) return false;
		await pending;
		return true;
	}

	function start(): Promise<void> {
		if (startPromise) return startPromise;
		// This must stay on start()'s synchronous path: callers may receive a
		// signal before the first startup promise yields even one microtask.
		if (!shutdownPromise) registerSignalHandlers();
		startPromise = (async () => {
			if (await finishShutdownIfRequested()) return;
			try {
				// Context start owns warmup, stale-upload recovery, and scheduler start
				// in dependency order. Construction and route registration stay I/O-free.
				await context.start();
				if (await finishShutdownIfRequested()) return;
				await app.listen({ port: config.PORT, host: '0.0.0.0' });
				if (await finishShutdownIfRequested()) return;
				context.lifecycle.setState('ready');
				context.logger.info(`Server listening on http://0.0.0.0:${config.PORT}`);
			} catch (error) {
				if (await finishShutdownIfRequested()) return;
				context.logger.fatal(error, 'Failed to start server');
				return closePreserving(error);
			}
		})();
		return startPromise;
	}

	function shutdown(reason: string): Promise<0 | 1> {
		shutdownPromise ??= (async () => {
			removeSignalHandlers();
			const deadline = Date.now() + config.SHUTDOWN_DRAIN_MS;
			const remainingMs = () => Math.max(0, deadline - Date.now());
			const waitWithinDeadline = async <T>(label: string, work: Promise<T>): Promise<T> => {
				const remaining = remainingMs();
				if (remaining <= 0) {
					throw new ShutdownDeadlineError(`Shutdown deadline exceeded before ${label}`);
				}
				let timer: NodeJS.Timeout | undefined;
				try {
					return await Promise.race([
						work,
						new Promise<T>((_resolve, reject) => {
							timer = setTimeout(
								() => reject(new ShutdownDeadlineError(`Shutdown deadline exceeded during ${label}`)),
								remaining,
							);
							timer.unref();
						}),
					]);
				} finally {
					if (timer) clearTimeout(timer);
				}
			};
			context.logger.info(`Received ${reason}, entering drain phase`);
			context.lifecycle.setState('draining');
			const closeReserveMs = Math.min(5_000, Math.max(1_000, Math.floor(config.SHUTDOWN_DRAIN_MS / 3)));
			const drainBudgetMs = Math.max(0, remainingMs() - closeReserveMs);
			const drainResult = await context.lifecycle.waitForDrain(drainBudgetMs);
			context.logger.info(
				{ drainResult, inFlight: context.lifecycle.inFlight() },
				'Drain phase complete',
			);
			context.lifecycle.setState('shutting_down');

			let closeFailed = drainResult !== 'drained';
			let deadlineExceeded = false;
			try {
				await waitWithinDeadline('Fastify close', app.close());
			} catch (error) {
				closeFailed = true;
				deadlineExceeded ||= error instanceof ShutdownDeadlineError || remainingMs() <= 0;
				context.logger.fatal(error, 'Error during shutdown close');
			} finally {
				try {
					await waitWithinDeadline('backend resource close', context.close());
				} catch (error) {
					closeFailed = true;
					deadlineExceeded ||= error instanceof ShutdownDeadlineError || remainingMs() <= 0;
					context.logger.fatal(error, 'Error closing backend resources');
				}
			}
			if (deadlineExceeded || remainingMs() <= 0) {
				const closable = app as FastifyInstance & {
					closeIdleConnections?(): void;
					closeAllConnections?(): void;
				};
				closable.closeIdleConnections?.();
				closable.closeAllConnections?.();
				context.logger.fatal(
					{ inFlight: context.lifecycle.inFlight(), reason },
					'Shutdown deadline exceeded; forcing process exit',
				);
				forceExit(1);
				return 1;
			}
			return drainResult === 'drained' && !closeFailed ? 0 : 1;
		})();
		return shutdownPromise;
	}

	return { start, shutdown };
}

export async function runProductionServer(config: Env): Promise<ServerRuntime> {
	const [{ createProductionBackendContext }, { buildApp }] = await Promise.all([
		import('./backend-context.js'),
		import('./app.js'),
	]);
	const context = await createProductionBackendContext(config);
	let app: FastifyInstance;
	try {
		app = await buildApp({ context });
	} catch (error) {
		await context.close().catch(() => undefined);
		throw error;
	}
	const runtime = createServerRuntime({ config, context, app });
	await runtime.start();
	return runtime;
}

async function main(): Promise<void> {
	const { loadEnv } = await import('./config/env.js');
	await runProductionServer(loadEnv());
}

const executedPath = process.argv[1];
if (executedPath && import.meta.url === pathToFileURL(executedPath).href) {
	void main().catch((error) => {
		console.error('Fatal startup error:', error);
		process.exitCode = 1;
	});
}
